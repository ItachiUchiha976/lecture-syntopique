// Indexation du texte d'un livre (pour la recherche) + détection des pages
// scannées sans texte (à passer à l'OCR en Phase 8). Tâche de fond.
import * as store from './storage.js';
import { loadDocument, destroyDoc } from './pdf-engine.js';
import { buildNormIndex } from './text-normalize.js';
import { countWords, hasRealText } from './word-counter.js';

const inProgress = new Set();   // bookIds en cours d'indexation (anti-doublon)
let pendingRunning = false;
const listeners = new Set();

// Version de l'index de recherche. À INCRÉMENTER quand la façon d'extraire/normaliser le
// texte change (ex. passage en NFKD + jointure avec espaces) → ré-indexe les livres existants.
const INDEX_VERSION = 2;

export function onIndexProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(evt) { for (const fn of listeners) { try { fn(evt); } catch {} } }

export function isIndexed(book) {
  return book && book.textSource && book.textSource !== 'unknown' && book.indexVersion === INDEX_VERSION;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cœur : indexe page par page avec un document déjà chargé (ne le détruit PAS).
async function indexWithDoc(book, pdfDoc) {
  const pageSizes = new Array(book.pageCount).fill(null);
  let withText = 0, needOcr = 0;
  await store.updateBook(book.id, { ocrStatus: 'pending' });
  for (let i = 1; i <= book.pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    pageSizes[i - 1] = { w: vp.width, h: vp.height };
    let text = '';
    try {
      const tc = await page.getTextContent();
      // Jointure avec une espace entre items (meilleure séparation des mots) puis normalisation des blancs.
      text = tc.items.map((it) => (it.str != null ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim();
    } catch {}
    page.cleanup();
    const real = hasRealText(text);
    // Ré-indexation sûre : page scannée SANS texte natif mais DÉJÀ OCRisée → on garde le texte OCR
    // (on régénère juste la normalisation), sans relancer l'OCR.
    let ocrApplied = false;
    if (!real) {
      const prev = await store.getPage(book.id, i - 1).catch(() => null);
      if (prev && prev.ocrApplied && prev.text) { text = prev.text; ocrApplied = true; }
    }
    const usable = real || ocrApplied; // la page a-t-elle un texte exploitable pour la recherche ?
    if (usable) withText++; else needOcr++;
    const { norm } = buildNormIndex(text);
    await store.patchPage(book.id, i - 1, {
      width: vp.width, height: vp.height,
      text, textNorm: norm, wordCount: countWords(text),
      needsOcr: !usable, ocrApplied,
    });
    emit({ bookId: book.id, done: i, total: book.pageCount });
    if (i % 8 === 0) await sleep(0); // laisse respirer l'UI
  }
  const textSource = needOcr === 0 ? 'native' : (withText === 0 ? 'scanned' : 'mixed');
  const updated = await store.updateBook(book.id, {
    textSource, pageSizes, indexVersion: INDEX_VERSION,
    ocrStatus: needOcr === 0 ? 'not-needed' : 'pending',
    ocrProgress: needOcr === 0 ? 1 : 0,
    pagesNeedingOcr: needOcr,
  });
  emit({ bookId: book.id, done: book.pageCount, total: book.pageCount, finished: true });
  // Déclenche l'OCR en fond pour les pages scannées détectées (import paresseux
  // de Tesseract.js : son code lourd n'est chargé que si nécessaire).
  if (needOcr > 0) {
    import('./ocr.js').then((m) => m.ocrBook(updated)).catch((e) => console.warn('[ocr] auto', e));
  }
  return updated;
}

// Indexe un livre (charge son propre document, le détruit ensuite). Garde anti-doublon.
export async function indexBook(book, { force = false } = {}) {
  if (!book) return book;
  if (!force && isIndexed(book)) return book;
  if (inProgress.has(book.id)) return book;
  inProgress.add(book.id);
  let pdfDoc = null;
  try {
    const bytes = await store.loadBinary(book.binaryRef);
    if (!bytes) throw new Error('Binaire introuvable pour indexation');
    pdfDoc = await loadDocument(bytes);
    return await indexWithDoc(book, pdfDoc);
  } finally {
    if (pdfDoc) destroyDoc(pdfDoc);
    inProgress.delete(book.id);
  }
}

// Indexe tous les livres non indexés, un par un, en arrière-plan.
export async function indexAllPending() {
  if (pendingRunning) return;
  pendingRunning = true;
  try {
    const books = await store.getAllBooks();
    for (const b of books) {
      if (isIndexed(b)) continue;
      try { await indexBook(b); } catch (e) { console.warn('[indexer]', b.title, e); }
    }
  } finally { pendingRunning = false; }
}
