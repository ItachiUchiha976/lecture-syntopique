// Recherche plein texte sur le texte indexé (pages.textNorm).
// Insensible à la casse et aux accents. Portée : livre courant ou tous les livres.
import * as store from './storage.js';
import { normalizeQuery, buildNormIndex } from './text-normalize.js';

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
    const pages = await store.getPagesByBook(b.id);
    pages.sort((a, b2) => a.pageIndex - b2.pageIndex);
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
