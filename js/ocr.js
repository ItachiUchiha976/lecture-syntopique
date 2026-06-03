// OCR des pages scannées (sans couche texte), en anglais + français.
// Rasterisation par PDF.js (premier plan), reconnaissance dans le worker intégré
// de Tesseract.js (l'UI reste réactive). Tout est vendorisé -> fonctionne hors-ligne.
import { loadDocument, destroyDoc } from './pdf-engine.js';
import * as store from './storage.js';
import { buildNormIndex } from './text-normalize.js';
import { countWords } from './word-counter.js';
import { sleep } from './utils.js';

const VEND = new URL('../vendor/tesseract/', import.meta.url).href;

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
    return T.createWorker(langs, 1, {
      workerPath: VEND + 'worker.min.js',
      corePath: VEND,
      langPath: VEND + 'lang/',
      gzip: true,
    });
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
export function onOcrProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) { for (const fn of listeners) { try { fn(e); } catch {} } }

// Lance l'OCR des pages "needsOcr" d'un livre.
export async function ocrBook(book, { langs = 'eng+fra' } = {}) {
  if (!book || inProgress.has(book.id)) return;
  const pages = await store.getPagesByBook(book.id);
  const need = pages.filter((p) => p.needsOcr).map((p) => p.pageIndex).sort((a, b) => a - b);
  if (!need.length) { await store.updateBook(book.id, { ocrStatus: 'not-needed', ocrProgress: 1 }); return; }

  inProgress.add(book.id);
  let pdfDoc = null;
  try {
    await store.updateBook(book.id, { ocrStatus: 'running' });
    emit({ bookId: book.id, done: 0, total: need.length, progress: 0 });
    const worker = await getWorker(langs);
    const bytes = await store.loadBinary(book.binaryRef);
    pdfDoc = await loadDocument(bytes.slice());

    let done = 0;
    for (const idx of need) {
      // Le livre a-t-il été supprimé pendant l'OCR ? Signal synchrone → on arrête net
      // (sinon patchPage recréerait des pages « fantômes » pour un livre qui n'existe plus).
      if (store.cancelledBooks.has(book.id)) break;
      const page = await pdfDoc.getPage(idx + 1);
      const vp1 = page.getViewport({ scale: 1 });
      // ~ bonne résolution pour l'OCR sans exploser la mémoire (une page à la fois)
      const scale = Math.max(1.5, Math.min(3, 2200 / Math.max(vp1.width, vp1.height)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();

      let text = '';
      try { const res = await worker.recognize(canvas); text = (res && res.data && res.data.text) || ''; }
      catch (e) { console.warn('[ocr] page', idx + 1, e); }
      canvas.width = canvas.height = 0;

      const { norm } = buildNormIndex(text);
      await store.patchPage(book.id, idx, { text, textNorm: norm, wordCount: countWords(text), ocrApplied: true, needsOcr: false });
      done++;
      const progress = done / need.length;
      await store.updateBook(book.id, { ocrProgress: progress });
      emit({ bookId: book.id, done, total: need.length, progress });
      await sleep(0);
    }
    await store.updateBook(book.id, { ocrStatus: 'done', ocrProgress: 1 });
    emit({ bookId: book.id, done: need.length, total: need.length, progress: 1, finished: true });
  } finally {
    if (pdfDoc) destroyDoc(pdfDoc);
    inProgress.delete(book.id);
    if (inProgress.size === 0) terminateWorker(); // plus aucun OCR en cours → on libère la mémoire du worker
  }
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
