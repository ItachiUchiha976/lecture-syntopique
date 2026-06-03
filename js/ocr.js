// OCR des pages scannées (sans couche texte), en anglais + français.
// Rasterisation par PDF.js (premier plan), reconnaissance dans le worker intégré
// de Tesseract.js (l'UI reste réactive). Tout est vendorisé -> fonctionne hors-ligne.
import { loadDocument, destroyDoc } from './pdf-engine.js';
import * as store from './storage.js';
import { buildNormIndex } from './text-normalize.js';
import { countWords } from './word-counter.js';
import { sleep } from './utils.js';

const VEND = new URL('../vendor/tesseract/', import.meta.url).href;

// Version de la MÉTHODE d'OCR. À INCRÉMENTER quand la reconnaissance change (résolution,
// prétraitement, paramètres Tesseract) : les pages scannées déjà reconnues avec une version
// ANTÉRIEURE repassent automatiquement à l'OCR (re-traitement) à la prochaine ouverture du livre.
export const OCR_VERSION = 3;

// Nombre de tentatives d'OCR avant d'abandonner et de DÉBLOQUER quand même la lecture (le livre est
// alors marqué ocrStatus:'error' + ocrFailCount, et signalé « OCR échouée » dans la bibliothèque).
export const OCR_MAX_ATTEMPTS = 3;

function loadTesseractLib() {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const s = document.createElement('script');
    s.src = VEND + 'tesseract.min.js';
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract non chargé'));
    s.onerror = () => reject(new Error('Échec de chargement de Tesseract.js'));
    document.head.appendChild(s);
  });
}

let workerPromise = null;
async function getWorker(langs) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const T = await loadTesseractLib();
    const w = await T.createWorker(langs, 1, {
      workerPath: VEND + 'worker.min.js',
      corePath: VEND,
      langPath: VEND + 'lang/',
      gzip: true,
    });
    // Paramètres de PRÉCISION : DPI explicite (évite le « Invalid resolution 0 dpi » et aide le
    // moteur à dimensionner le texte) + conservation des espaces entre mots (meilleure séparation).
    try { await w.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' }); } catch {}
    return w;
  })();
  return workerPromise;
}
// Libère le worker Tesseract (langues eng+fra = plusieurs Mo) quand plus aucun OCR n'est en cours.
async function terminateWorker() {
  if (!workerPromise) return;
  const p = workerPromise; workerPromise = null;
  try { const w = await p; await w.terminate(); } catch {}
}

const inProgress = new Set();
const listeners = new Set();

// Reconnaît un canvas et renvoie les MOTS avec leur boîte (bbox px, repère haut-gauche).
// Utilisé par l'export pour reconstruire une couche de texte cherchable sur les pages
// scannées raturées (les zones masquées sont noires → aucun mot reconnu dessus → pas de fuite).
// NB : `blocks:true` est requis (le défaut de Tesseract.js est `blocks:false`, donc pas de positions).
export async function ocrCanvasWords(canvas, langs = 'eng+fra') {
  const worker = await getWorker(langs);
  const res = await worker.recognize(canvas, {}, { blocks: true });
  const out = [];
  const blocks = (res && res.data && res.data.blocks) || [];
  for (const b of blocks)
    for (const p of (b.paragraphs || []))
      for (const l of (p.lines || []))
        for (const w of (l.words || []))
          if (w && w.text && w.text.trim() && w.bbox) out.push({ text: w.text, bbox: w.bbox });
  return out;
}

// Libère le worker OCR si plus aucun OCR de fond n'est en cours (à appeler après un export).
export async function releaseOcrWorker() { if (inProgress.size === 0) await terminateWorker(); }
export function onOcrProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) { for (const fn of listeners) { try { fn(e); } catch {} } }

// Prétraitement d'un canvas avant l'OCR (en place) : conversion en niveaux de gris puis
// ÉTIREMENT DE CONTRASTE (uniquement si le contraste est faible — sinon no-op). Améliore
// nettement la reconnaissance des scans pâles/jaunis sans abîmer le texte déjà net.
// Traité PAR BANDES : on ne charge jamais l'image entière en RAM en plus du canvas (le tampon
// temporaire est borné à ~largeur×512×4 octets), pour éviter un pic mémoire sur iPad (haute résolution).
const OCR_BAND_H = 512;
function preprocessForOcr(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  // Passe 1 : niveaux de gris (en place) + min/max global pour décider d'un étirement.
  let min = 255, max = 0;
  for (let y = 0; y < h; y += OCR_BAND_H) {
    const bh = Math.min(OCR_BAND_H, h - y);
    let img;
    try { img = ctx.getImageData(0, y, w, bh); } catch { return; }
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    ctx.putImageData(img, 0, y);
  }
  const range = max - min;
  if (range <= 0 || range >= 235) return; // contraste déjà bon → pas d'étirement
  // Passe 2 : étirement de contraste sur [0..255], bande par bande (image déjà en gris).
  const k = 255 / range;
  for (let y = 0; y < h; y += OCR_BAND_H) {
    const bh = Math.min(OCR_BAND_H, h - y);
    let img;
    try { img = ctx.getImageData(0, y, w, bh); } catch { return; }
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let v = ((d[i] - min) * k) | 0;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, y);
  }
}

// UNE passe d'OCR : traite les pages encore `needsOcr` (recalculées à chaque appel → reprise
// automatique d'une passe interrompue). Les erreurs PAR PAGE sont tolérées (texte vide, page
// marquée traitée) ; un échec DUR (worker/Tesseract qui ne charge pas, document illisible) LÈVE
// → la passe est rejouée par ocrBook (jusqu'à OCR_MAX_ATTEMPTS).
async function runOcrPass(book, langs) {
  const pages = await store.getPagesByBook(book.id);
  const need = pages.filter((p) => p.needsOcr).map((p) => p.pageIndex).sort((a, b) => a - b);
  if (!need.length) return;
  await store.updateBook(book.id, { ocrStatus: 'running' });
  emit({ bookId: book.id, done: 0, total: need.length, progress: 0, etaMs: null });
  const worker = await getWorker(langs);                 // peut LEVER (échec dur → retry)
  const bytes = await store.loadBinary(book.binaryRef);
  if (!bytes) throw new Error('Binaire PDF introuvable pour OCR');
  let pdfDoc = null;
  try {
    pdfDoc = await loadDocument(bytes.slice());           // peut LEVER (échec dur → retry)
    let done = 0;
    const t0 = performance.now(); // base de temps pour estimer le temps restant (ETA)
    for (const idx of need) {
      // Le livre a-t-il été supprimé pendant l'OCR ? Signal synchrone → on arrête net
      // (sinon patchPage recréerait des pages « fantômes » pour un livre qui n'existe plus).
      if (store.cancelledBooks.has(book.id)) return;
      const page = await pdfDoc.getPage(idx + 1);
      const vp1 = page.getViewport({ scale: 1 });
      // Haute résolution (~250–300 DPI sur le plus grand côté) pour une OCR PRÉCISE, bornée pour
      // tenir dans la mémoire de l'iPad (une seule page rendue à la fois, libérée juste après).
      const scale = Math.max(2, Math.min(3.5, 3000 / Math.max(vp1.width, vp1.height)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
      preprocessForOcr(canvas); // niveaux de gris + étirement de contraste → reconnaissance plus fiable

      let text = '', ocrWords = [];
      try {
        // `blocks: true` est requis pour obtenir les POSITIONS des mots (bbox). On en tire le texte
        // ET les boîtes de mots, stockées en unités PDF (échelle 1, origine haut-gauche), arrondies —
        // elles servent à surligner le terme recherché sur les pages SCANNÉES (sans couche texte).
        const res = await worker.recognize(canvas, {}, { blocks: true });
        text = (res && res.data && res.data.text) || '';
        const blocks = (res && res.data && res.data.blocks) || [];
        for (const b of blocks)
          for (const p of (b.paragraphs || []))
            for (const l of (p.lines || []))
              for (const w of (l.words || [])) {
                if (!w || !w.text || !w.text.trim() || !w.bbox) continue;
                const bb = w.bbox;
                ocrWords.push({
                  t: w.text,
                  x: Math.round(bb.x0 / scale), y: Math.round(bb.y0 / scale),
                  w: Math.round((bb.x1 - bb.x0) / scale), h: Math.round((bb.y1 - bb.y0) / scale),
                });
              }
      } catch (e) { console.warn('[ocr] page', idx + 1, e); }
      canvas.width = canvas.height = 0;

      // Re-test JUSTE avant l'écriture : si le livre vient d'être supprimé pendant le long
      // `recognize`, ne pas recréer une page fantôme.
      if (store.cancelledBooks.has(book.id)) return;
      // Texte indexé = la MÊME séquence de tokens que celle utilisée pour le surlignage (ocrWords),
      // afin que le `count` de la recherche et les intervalles surlignés COÏNCIDENT exactement (sinon
      // l'occurrence « courante » ambre et la navigation ↑/↓ se désalignent). Repli sur le texte brut
      // si aucun mot positionné n'a été obtenu. Blancs aplatis (comme l'indexeur natif) → la recherche
      // d'EXPRESSIONS marche même à cheval sur une fin de ligne.
      const joinedWords = ocrWords.map((w) => w.t).join(' ');
      const flat = (joinedWords || String(text)).replace(/\s+/g, ' ').trim();
      const { norm } = buildNormIndex(flat);
      await store.patchPage(book.id, idx, { text: flat, textNorm: norm, wordCount: countWords(flat), ocrWords, ocrApplied: true, ocrVersion: OCR_VERSION, needsOcr: false });
      done++;
      const progress = done / need.length;
      // ETA = temps moyen par page déjà traitée × pages restantes (s'affine à chaque page).
      const etaMs = Math.max(0, Math.round(((performance.now() - t0) / done) * (need.length - done)));
      await store.updateBook(book.id, { ocrProgress: progress });
      emit({ bookId: book.id, done, total: need.length, progress, etaMs });
      await sleep(0);
    }
  } finally {
    if (pdfDoc) destroyDoc(pdfDoc);
  }
}

// Lance l'OCR des pages "needsOcr" d'un livre, avec re-tentatives. Après OCR_MAX_ATTEMPTS échecs
// DURS, on marque le livre `ocrStatus:'error'` (+ ocrFailCount) et on émet `failed` → la lecture
// est débloquée (le verrou laisse alors ouvrir, sans recherche), et la bibliothèque l'affiche.
export async function ocrBook(book, { langs = 'eng+fra', maxAttempts = OCR_MAX_ATTEMPTS } = {}) {
  if (!book || inProgress.has(book.id)) return;
  const pages = await store.getPagesByBook(book.id);
  if (!pages.some((p) => p.needsOcr)) {
    await store.updateBook(book.id, { ocrStatus: 'not-needed', ocrProgress: 1, ocrVersion: OCR_VERSION, pagesNeedingOcr: 0 });
    return;
  }
  inProgress.add(book.id);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runOcrPass(book, langs);
        if (store.cancelledBooks.has(book.id)) return; // supprimé pendant la passe → ne rien graver
        await store.updateBook(book.id, { ocrStatus: 'done', ocrProgress: 1, ocrVersion: OCR_VERSION, pagesNeedingOcr: 0, ocrFailCount: 0 });
        emit({ bookId: book.id, finished: true, etaMs: 0 });
        return;
      } catch (err) {
        console.warn('[ocr] échec tentative ' + attempt + '/' + maxAttempts, book.title, err);
        // Repartir d'un worker neuf avant de réessayer — MAIS pas si une AUTRE OCR tourne en parallèle
        // (le worker est un singleton partagé : le terminer corromprait silencieusement l'autre livre).
        if (inProgress.size <= 1) await terminateWorker();
        if (store.cancelledBooks.has(book.id)) return;
        if (attempt < maxAttempts) { emit({ bookId: book.id, retry: attempt + 1, attempts: maxAttempts }); await sleep(600); }
      }
    }
    // Échec après toutes les tentatives : on NE piège PAS l'utilisateur → lecture débloquée + signalement.
    await store.updateBook(book.id, { ocrStatus: 'error', ocrFailCount: maxAttempts });
    emit({ bookId: book.id, failed: true, attempts: maxAttempts });
  } finally {
    inProgress.delete(book.id);
    if (inProgress.size === 0) terminateWorker(); // plus aucun OCR en cours → on libère la mémoire du worker
  }
}

// Marque pour RE-OCR les pages scannées dont la reconnaissance n'est pas à la version courante
// (re-traitement des livres importés avant l'amélioration de précision). Saute les pages déjà
// reconnues avec OCR_VERSION → reprise sûre si un re-traitement a été interrompu. Renvoie le
// nombre de pages à (re)traiter.
export async function prepareReocr(book) {
  // Une OCR tourne déjà pour ce livre (run de fond) → ne pas réécrire son état (barre/ETA qui
  // sauteraient en arrière) ; on laisse le run en cours finir et le verrou s'abonne à ses évènements.
  if (inProgress.has(book.id)) return book.pagesNeedingOcr || 0;
  const pages = await store.getPagesByBook(book.id);
  let count = 0;
  for (const p of pages) {
    const scanned = p.ocrApplied || p.needsOcr;        // page sans texte natif (scannée)
    if (!scanned) continue;                            // page native → on n'y touche pas
    if (p.ocrApplied && p.ocrVersion === OCR_VERSION) continue; // déjà à la version courante
    await store.patchPage(book.id, p.pageIndex, { needsOcr: true });
    count++;
  }
  await store.updateBook(book.id, {
    pagesNeedingOcr: count,
    ocrStatus: count ? 'pending' : 'done',
    ocrProgress: count ? 0 : 1,
    // Rien à refaire (tout est déjà à jour) → on grave la version courante pour ne plus re-déclencher.
    ...(count ? {} : { ocrVersion: OCR_VERSION }),
  });
  return count;
}

// OCR de tous les livres dont des pages scannées attendent l'OCR.
export async function ocrAllPending() {
  const books = await store.getAllBooks();
  for (const b of books) {
    if ((b.ocrStatus === 'pending' || b.ocrStatus === 'running') && (b.pagesNeedingOcr || 0) > 0) {
      try { await ocrBook(b); } catch (e) { console.warn('[ocr]', b.title, e); }
    }
  }
}
