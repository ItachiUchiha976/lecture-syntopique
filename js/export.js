// Génération du PDF filtré.
//  - Suppression DÉFINITIVE des pages marquées "censurées" (removePage, ordre décroissant).
//  - Pages conservées : soit GRAVURE irréversible (page rasterisée en image avec
//    censures aplaties — le texte sous les masques disparaît), soit mode LÉGER
//    (rectangles noirs pdf-lib superposés ; le texte sous le masque resterait
//    extractible — l'UI en avertit l'utilisateur).
import { loadDocument, destroyDoc } from './pdf-engine.js';
import * as store from './storage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Dessine les masques sur un canvas (coordonnées PDF top-left * scale = px).
function drawMarksCanvas(ctx, marks, scale) {
  ctx.fillStyle = '#000';
  for (const m of marks || []) {
    if (m.type === 'rect') {
      ctx.fillRect(m.rect.x * scale, m.rect.y * scale, m.rect.w * scale, m.rect.h * scale);
    } else if (m.type === 'highlight') {
      for (const q of m.quads) ctx.fillRect(q.x * scale, q.y * scale, q.w * scale, q.h * scale);
    } else if (m.type === 'marker' && m.path && m.path.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.32)'; ctx.lineWidth = (m.width || 0) * scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(m.path[0].x * scale, m.path[0].y * scale);
      for (let k = 1; k < m.path.length; k++) ctx.lineTo(m.path[k].x * scale, m.path[k].y * scale);
      if (m.path.length === 1) ctx.lineTo(m.path[0].x * scale + 0.1, m.path[0].y * scale);
      ctx.stroke();
      ctx.restore();
    } else if (m.type === 'lasso' && m.path && m.path.length > 2) {
      ctx.beginPath();
      ctx.moveTo(m.path[0].x * scale, m.path[0].y * scale);
      for (let k = 1; k < m.path.length; k++) ctx.lineTo(m.path[k].x * scale, m.path[k].y * scale);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// Dessine les masques en mode léger (rectangles/chemins pdf-lib, origine bas-gauche).
function drawMarksLight(PDFLib, page, marks) {
  const { rgb } = PDFLib;
  const H = page.getHeight();
  const black = rgb(0.04, 0.07, 0.12);
  for (const m of marks || []) {
    if (m.type === 'rect') {
      page.drawRectangle({ x: m.rect.x, y: H - m.rect.y - m.rect.h, width: m.rect.w, height: m.rect.h, color: black });
    } else if (m.type === 'highlight') {
      for (const q of m.quads) page.drawRectangle({ x: q.x, y: H - q.y - q.h, width: q.w, height: q.h, color: black });
    } else if (m.type === 'marker' && m.path && m.path.length > 1) {
      // Surligneur d'emphase : bleu translucide (texte visible) — pas une censure.
      const w = m.width || 6;
      const blue = rgb(0.145, 0.388, 0.922);
      const cap = PDFLib.LineCapStyle ? PDFLib.LineCapStyle.Round : undefined;
      for (let k = 0; k < m.path.length - 1; k++) {
        page.drawLine({ start: { x: m.path[k].x, y: H - m.path[k].y }, end: { x: m.path[k + 1].x, y: H - m.path[k + 1].y }, thickness: w, color: blue, opacity: 0.32, lineCap: cap });
      }
    } else if (m.type === 'lasso' && m.path && m.path.length > 2) {
      // drawSvgPath : origine en haut-gauche, y vers le bas -> nos coordonnées conviennent.
      const d = 'M ' + m.path.map((p) => `${p.x} ${p.y}`).join(' L ') + ' Z';
      page.drawSvgPath(d, { color: black, borderWidth: 0 });
    }
  }
}

function chooseScale(w, h) {
  const maxSide = Math.max(w, h);
  return Math.max(1, Math.min(2, 2200 / maxSide));
}

async function buildRasterizedExport(PDFLib, book, srcBytes, byIndex, censoredSet, onProgress) {
  const out = await PDFLib.PDFDocument.create();
  const pdfDoc = await loadDocument(srcBytes.slice());
  const total = book.pageCount;
  let done = 0;
  try {
    for (let idx = 0; idx < total; idx++) {
      if (!censoredSet.has(idx)) {
        const page = await pdfDoc.getPage(idx + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = chooseScale(vp1.width, vp1.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(vp.width));
        canvas.height = Math.max(1, Math.ceil(vp.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const rec = byIndex[idx];
        if (rec && rec.censorMarks) drawMarksCanvas(ctx, rec.censorMarks, scale);
        page.cleanup();
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        const jpegBytes = new Uint8Array(await blob.arrayBuffer());
        const img = await out.embedJpg(jpegBytes);
        const newPage = out.addPage([vp1.width, vp1.height]);
        newPage.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        canvas.width = canvas.height = 0;
      }
      done++; if (onProgress) onProgress(done, total);
      await sleep(0);
    }
  } finally {
    destroyDoc(pdfDoc);
  }
  return out.save();
}

async function buildLightExport(PDFLib, srcBytes, byIndex, censoredSet, total, onProgress) {
  const doc = await PDFLib.PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const n = doc.getPageCount();
  for (let idx = 0; idx < n; idx++) {
    if (!censoredSet.has(idx)) {
      const rec = byIndex[idx];
      if (rec && rec.censorMarks && rec.censorMarks.length) {
        try { drawMarksLight(PDFLib, doc.getPage(idx), rec.censorMarks); } catch (e) { console.warn('[export] mark', idx, e); }
      }
    }
    if (onProgress) onProgress(idx + 1, total);
  }
  const toRemove = [...censoredSet].sort((a, b) => b - a); // descendant : indices stables
  for (const idx of toRemove) { if (idx < doc.getPageCount()) doc.removePage(idx); }
  return doc.save();
}

// Retourne un Uint8Array du PDF filtré.
export async function exportFilteredPdf(book, { burnPartial = false, onProgress = null } = {}) {
  const PDFLib = await loadPdfLib();
  const pages = await store.getPagesByBook(book.id);
  const byIndex = {};
  const censoredSet = new Set();
  for (const p of pages) { byIndex[p.pageIndex] = p; if (p.censored) censoredSet.add(p.pageIndex); }
  const srcBytes = await store.loadBinary(book.binaryRef);
  if (!srcBytes) throw new Error('Fichier PDF source introuvable.');

  if (burnPartial) return buildRasterizedExport(PDFLib, book, srcBytes, byIndex, censoredSet, onProgress);
  return buildLightExport(PDFLib, srcBytes, byIndex, censoredSet, book.pageCount, onProgress);
}

export function countCensored(pages) { return pages.filter((p) => p.censored).length; }
