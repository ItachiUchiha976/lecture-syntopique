// Génération du PDF filtré (REDACTION qui CONSERVE le texte cherchable).
//  - Pages marquées « censurées » : supprimées DÉFINITIVEMENT (ordre décroissant implicite : on ne les ajoute pas).
//  - Pages SANS rature : copiées telles quelles -> texte natif PARFAIT conservé (et rapide).
//  - Pages AVEC ratures (rectangle / forme libre) : rasterisées (l'image grave les masques noirs -> le texte
//    sous le masque disparaît VRAIMENT), puis on RÉINJECTE une couche de texte INVISIBLE mais cherchable,
//    en EXCLUANT le texte sous les masques :
//      • page numérique -> positions du texte natif (getTextContent), items sous un masque écartés ;
//      • page scannée   -> ré-OCR de l'image raturée (les zones noires ne renvoient aucun mot -> pas de fuite).
//  - Pages scannées NON raturées : on injecte le texte OCR déjà stocké (cherchable, contenu précis).
//  Le surligneur bleu (emphase) n'est PAS une censure : il est tracé en bleu translucide, texte visible.
import { loadDocument, destroyDoc } from './pdf-engine.js';
import * as store from './storage.js';
import { pointInPolygon } from './stroke-smoothing.js';
import { ocrCanvasWords, releaseOcrWorker } from './ocr.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Types de masques qui CACHENT réellement du contenu (à graver en noir + à exclure du texte).
const HIDING_TYPES = new Set(['rect', 'lasso', 'highlight']);
const hidingMarks = (marks) => (marks || []).filter((m) => HIDING_TYPES.has(m.type));
const markerMarks = (marks) => (marks || []).filter((m) => m.type === 'marker');

function loadPdfLib() {
  return new Promise((resolve, reject) => {
    if (window.PDFLib) return resolve(window.PDFLib);
    const src = new URL('../vendor/pdf-lib/pdf-lib.min.js', import.meta.url).href;
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib non chargé'));
    s.onerror = () => reject(new Error('Échec de chargement de pdf-lib'));
    document.head.appendChild(s);
  });
}

function chooseScale(w, h) {
  const maxSide = Math.max(w, h);
  return Math.max(1, Math.min(2, 2200 / maxSide));
}

// Dessine les masques sur le canvas rasterisé (coordonnées PDF top-left * scale = px).
// rect/lasso/highlight = noir opaque (censure gravée) ; marker = bleu translucide (emphase, texte visible).
function drawMarksCanvas(ctx, marks, scale) {
  for (const m of marks || []) {
    if (m.type === 'rect') {
      ctx.fillStyle = '#000';
      ctx.fillRect(m.rect.x * scale, m.rect.y * scale, m.rect.w * scale, m.rect.h * scale);
    } else if (m.type === 'highlight') {
      ctx.fillStyle = '#000';
      for (const q of m.quads) ctx.fillRect(q.x * scale, q.y * scale, q.w * scale, q.h * scale);
    } else if (m.type === 'lasso' && m.path && m.path.length > 2) {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.moveTo(m.path[0].x * scale, m.path[0].y * scale);
      for (let k = 1; k < m.path.length; k++) ctx.lineTo(m.path[k].x * scale, m.path[k].y * scale);
      ctx.closePath();
      ctx.fill();
    } else if (m.type === 'marker' && m.path && m.path.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.32)'; ctx.lineWidth = (m.width || 0) * scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(m.path[0].x * scale, m.path[0].y * scale);
      for (let k = 1; k < m.path.length; k++) ctx.lineTo(m.path[k].x * scale, m.path[k].y * scale);
      if (m.path.length === 1) ctx.lineTo(m.path[0].x * scale + 0.1, m.path[0].y * scale);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// Surligneur bleu d'emphase tracé sur une page pdf-lib copiée (origine bas-gauche).
function drawMarkersLight(PDFLib, page, markers) {
  const { rgb } = PDFLib;
  const H = page.getHeight();
  const blue = rgb(0.145, 0.388, 0.922);
  const cap = PDFLib.LineCapStyle ? PDFLib.LineCapStyle.Round : undefined;
  for (const m of markers) {
    if (m.type === 'marker' && m.path && m.path.length > 1) {
      const w = m.width || 6;
      for (let k = 0; k < m.path.length - 1; k++) {
        page.drawLine({ start: { x: m.path[k].x, y: H - m.path[k].y }, end: { x: m.path[k + 1].x, y: H - m.path[k + 1].y },
          thickness: w, color: blue, opacity: 0.32, lineCap: cap });
      }
    }
  }
}

// ---- Couche de texte INVISIBLE mais cherchable ----------------------------------
// Remplacements pour rester encodable par la police standard (WinAnsi / CP1252).
const TEXT_REPL = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-', '…': '...',
  ' ': ' ', '•': '-', '‹': '<', '›': '>',
  'ﬁ': 'fi', 'ﬂ': 'fl', 'Œ': 'OE', 'œ': 'oe',
};
function sanitizeWinAnsi(str) {
  let out = '';
  for (const ch of String(str)) {
    if (TEXT_REPL[ch] !== undefined) { out += TEXT_REPL[ch]; continue; }
    const cp = ch.codePointAt(0);
    if (cp === 9 || cp === 10 || cp === 13 || cp === 32) { out += ' '; continue; }
    if (cp < 32) continue;
    if (cp <= 0x7E) { out += ch; continue; }            // ASCII imprimable
    if (cp >= 0xA0 && cp <= 0xFF) { out += ch; continue; } // Latin-1 (accents FR)
    if (ch === '€') { out += ch; continue; }         // € (présent en WinAnsi)
    out += ' ';                                           // hors CP1252 -> espace (cherchabilité préservée)
  }
  return out;
}

// Texte invisible (opacity 0) mais présent dans le flux -> cherchable/copiable/extractible par une IA.
function drawHiddenText(page, font, str, x, y, size, opts = {}) {
  const s = sanitizeWinAnsi(str);
  if (!s.trim()) return;
  const o = { x, y, size: Math.max(1, Math.min(size, 120)), font, opacity: 0, ...opts };
  try { page.drawText(s, o); }
  catch { try { page.drawText(s.replace(/[^\x20-\x7E]/g, ' '), o); } catch {} }
}

// Un item de texte (rect top-left) est-il sous un masque qui cache ? (conservateur : on écarte au moindre chevauchement)
function overlapsHiding(rect, hides) {
  for (const m of hides) {
    if (m.type === 'rect') {
      const r = m.rect;
      if (rect.x < r.x + r.w && rect.x + rect.w > r.x && rect.y < r.y + r.h && rect.y + rect.h > r.y) return true;
    } else if (m.type === 'highlight') {
      for (const q of m.quads) if (rect.x < q.x + q.w && rect.x + rect.w > q.x && rect.y < q.y + q.h && rect.y + rect.h > q.y) return true;
    } else if (m.type === 'lasso' && m.path && m.path.length > 2) {
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      const probes = [[cx, cy], [rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]];
      for (const [px, py] of probes) if (pointInPolygon(px, py, m.path)) return true;
    }
  }
  return false;
}

// Page numérique rasterisée : réinjecte le texte natif (positions exactes), en excluant ce qui est sous un masque.
function addNativeHiddenText(page, font, items, hides, pageH) {
  for (const it of items) {
    const s = it.str;
    if (!s || !s.trim()) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4], baselineY = tr[5];
    const size = Math.abs(tr[3]) || it.height || 10;
    const w = it.width || 0, h = it.height || size;
    const rectTL = { x, y: pageH - baselineY - h, w, h: h * 1.25 };
    if (hides.length && overlapsHiding(rectTL, hides)) continue; // sous un masque -> ne PAS réinjecter (pas de fuite)
    drawHiddenText(page, font, s, x, baselineY, size);
  }
}

// Page scannée rasterisée : réinjecte les mots OCR (positions de l'image raturée ; zones noires = aucun mot).
function addOcrHiddenText(page, font, words, scale, pageH) {
  for (const w of words) {
    const b = w.bbox; if (!b) continue;
    const x = b.x0 / scale;
    const baselineY = pageH - (b.y1 / scale);
    const size = Math.max(4, (b.y1 - b.y0) / scale);
    drawHiddenText(page, font, w.text, x, baselineY, size);
  }
}

// Page scannée NON raturée (copiée intacte) : injecte le texte OCR déjà stocké, pour rester cherchable.
// Positions approximatives (le texte stocké n'a pas de boîtes) mais contenu exact, en ordre de lecture.
function injectStoredOcrText(page, font, text) {
  const W = page.getWidth(), H = page.getHeight();
  const margin = 24, size = 9;
  drawHiddenText(page, font, text, margin, H - margin, size, { maxWidth: W - 2 * margin, lineHeight: size * 1.2 });
}

// Retourne un Uint8Array du PDF filtré (mode REDACTION gravé, texte cherchable conservé).
export async function exportFilteredPdf(book, { onProgress = null } = {}) {
  const PDFLib = await loadPdfLib();
  const { StandardFonts } = PDFLib;
  const pages = await store.getPagesByBook(book.id);
  const byIndex = {};
  const censoredSet = new Set();
  for (const p of pages) { byIndex[p.pageIndex] = p; if (p.censored) censoredSet.add(p.pageIndex); }
  const srcBytes = await store.loadBinary(book.binaryRef);
  if (!srcBytes) throw new Error('Fichier PDF source introuvable.');

  const out = await PDFLib.PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const srcDoc = await PDFLib.PDFDocument.load(srcBytes, { ignoreEncryption: true }); // pour copier les pages intactes
  const pdfDoc = await loadDocument(srcBytes.slice());                                // pour rasteriser + texte natif

  const total = book.pageCount;
  const langs = (await store.getSetting('ocrLangs')) || 'eng+fra';

  // Plan par page : 'remove' (censurée), 'raster' (a des ratures), ou 'copy' (intacte).
  const plan = [];
  const copyIndices = [];
  for (let idx = 0; idx < total; idx++) {
    if (censoredSet.has(idx)) { plan.push({ idx, mode: 'remove' }); continue; }
    const rec = byIndex[idx];
    const marks = (rec && rec.censorMarks) || [];
    const scannedPage = !!(rec && (rec.ocrApplied || rec.needsOcr));
    if (hidingMarks(marks).length) plan.push({ idx, mode: 'raster', marks, scannedPage });
    else { plan.push({ idx, mode: 'copy', marks, scannedPage, rec }); copyIndices.push(idx); }
  }
  // Copie GROUPÉE des pages intactes (un seul appel → pas de duplication des polices/images partagées).
  const copiedByIdx = new Map();
  if (copyIndices.length) {
    const copied = await out.copyPages(srcDoc, copyIndices);
    copyIndices.forEach((idx, k) => copiedByIdx.set(idx, copied[k]));
  }

  let done = 0, usedOcr = false;
  try {
    for (const item of plan) {
      const idx = item.idx;
      if (item.mode === 'remove') { done++; if (onProgress) onProgress(done, total); continue; }

      if (item.mode === 'raster') {
        const marks = item.marks;
        const hides = hidingMarks(marks);
        const hasNativeText = !item.scannedPage;
        // --- Rasterisation + gravure des masques + couche texte cherchable ---
        const pjs = await pdfDoc.getPage(idx + 1);
        const vp1 = pjs.getViewport({ scale: 1 });
        const scale = chooseScale(vp1.width, vp1.height);
        const vp = pjs.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(vp.width));
        canvas.height = Math.max(1, Math.ceil(vp.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pjs.render({ canvasContext: ctx, viewport: vp }).promise;
        drawMarksCanvas(ctx, marks, scale);

        // Prépare la couche texte AVANT de libérer le canvas (l'OCR en a besoin).
        const rotated = ((pjs.rotate || 0) % 360) !== 0; // sur page pivotée, le texte natif et l'image ne partagent
                                                          // pas le même repère -> on s'abstient (image seule, pas de fuite).
        let nativeItems = null, ocrWords = null;
        if (hasNativeText && !rotated) { try { nativeItems = (await pjs.getTextContent()).items; } catch {} }
        else if (!hasNativeText) { try { ocrWords = await ocrCanvasWords(canvas, langs); usedOcr = true; } catch (e) { console.warn('[export] ocr', idx + 1, e); } }
        pjs.cleanup();

        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        const jpegBytes = new Uint8Array(await blob.arrayBuffer());
        canvas.width = canvas.height = 0;
        const img = await out.embedJpg(jpegBytes);
        const newPage = out.addPage([vp1.width, vp1.height]);
        newPage.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });

        try {
          if (nativeItems) addNativeHiddenText(newPage, font, nativeItems, hides, vp1.height);
          else if (ocrWords) addOcrHiddenText(newPage, font, ocrWords, scale, vp1.height);
        } catch (e) { console.warn('[export] couche texte', idx + 1, e); }
      } else {
        // --- Page sans rature : copie native intacte (texte natif conservé, rapide) ---
        const copied = copiedByIdx.get(idx);
        if (copied) {
          out.addPage(copied);
          const blue = markerMarks(item.marks);
          if (blue.length) { try { drawMarkersLight(PDFLib, copied, blue); } catch (e) { console.warn('[export] marqueur', idx + 1, e); } }
          // Page scannée non raturée : injecte le texte OCR stocké pour qu'elle reste cherchable.
          if (item.scannedPage && item.rec && item.rec.text && item.rec.text.trim()) {
            try { injectStoredOcrText(copied, font, item.rec.text); } catch (e) { console.warn('[export] texte OCR', idx + 1, e); }
          }
        }
      }
      done++; if (onProgress) onProgress(done, total);
      await sleep(0);
    }
  } finally {
    try { destroyDoc(pdfDoc); } catch {}
    if (usedOcr) { try { await releaseOcrWorker(); } catch {} }
  }
  return out.save();
}

export function countCensored(pages) { return pages.filter((p) => p.censored).length; }
