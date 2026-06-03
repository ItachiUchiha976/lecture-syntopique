// Recherche plein texte sur le texte indexé (pages.textNorm).
// Insensible à la casse et aux accents. Portée : livre courant ou tous les livres.
import * as store from './storage.js';
import { normalizeQuery, buildNormIndex } from './text-normalize.js';
import { onOcrProgress } from './ocr.js';
import { onIndexProgress } from './text-indexer.js';

// Cache LÉGER des pages par livre pour la recherche : { pageIndex, text, textNorm } SANS `ocrWords`
// (les positions de mots OCR sont volumineuses et inutiles ici). Évite de relire tous les records de
// page — `ocrWords` compris — à CHAQUE frappe. Invalidé quand l'OCR/indexation modifie un texte.
const _searchCache = new Map(); // bookId -> [{ pageIndex, text, textNorm }]
// Invalide le cache : un livre précis (bookId) ou tout (sans argument). Exporté pour que la suppression
// et la restauration d'un livre forcent une relecture (sinon des résultats périmés après delete+restore).
export function clearSearchCache(bookId) { if (bookId == null) _searchCache.clear(); else _searchCache.delete(bookId); }
onOcrProgress((e) => { if (e && (e.finished || e.failed)) clearSearchCache(); });
onIndexProgress((e) => { if (e && e.finished) clearSearchCache(); });

async function pagesForSearch(bookId) {
  let arr = _searchCache.get(bookId);
  if (!arr) {
    const pages = await store.getPagesByBook(bookId);
    arr = pages
      .filter((p) => p.textNorm)
      .map((p) => ({ pageIndex: p.pageIndex, text: p.text || '', textNorm: p.textNorm }))
      .sort((a, b) => a.pageIndex - b.pageIndex);
    _searchCache.set(bookId, arr);
  }
  return arr;
}

function makeSnippet(text, q) {
  if (!text) return '';
  const { norm, map } = buildNormIndex(text);
  const i = norm.indexOf(q);
  if (i < 0) return '';
  const startOrig = map[i] ?? 0;
  const endNormChar = Math.min(i + q.length, map.length - 1);
  const endOrig = map[endNormChar] ?? startOrig + q.length;
  const ctx = 34;
  const from = Math.max(0, startOrig - ctx);
  const to = Math.min(text.length, endOrig + ctx);
  let s = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) s = '… ' + s;
  if (to < text.length) s = s + ' …';
  return s;
}

// Retourne une liste de résultats par page :
// { bookId, bookTitle, pageIndex, count, snippet }
// scope : 'book' (livre sélectionné = bookId) | 'open' (les livres ouverts = openBookIds) | 'all' (tous les importés).
export async function searchText(query, { scope = 'book', bookId = null, openBookIds = null } = {}) {
  const q = normalizeQuery(query);
  if (!q) return { query: q, results: [], totalOccurrences: 0 };

  let books;
  if (scope === 'book') books = [await store.getBook(bookId)].filter(Boolean);
  else if (scope === 'open') books = (await Promise.all((openBookIds || []).map((id) => store.getBook(id)))).filter(Boolean);
  else books = await store.getAllBooks();

  const results = [];
  let totalOccurrences = 0;
  for (const b of books) {
    const pages = await pagesForSearch(b.id); // léger + mis en cache (sans ocrWords)
    for (const p of pages) {
      if (!p.textNorm) continue;
      let count = 0, idx = p.textNorm.indexOf(q);
      if (idx === -1) continue;
      while (idx !== -1) { count++; idx = p.textNorm.indexOf(q, idx + q.length); }
      totalOccurrences += count;
      results.push({
        bookId: b.id, bookTitle: b.title, pageIndex: p.pageIndex,
        count, snippet: makeSnippet(p.text || '', q),
      });
    }
  }
  return { query: q, results, totalOccurrences };
}
