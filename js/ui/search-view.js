// Overlay de recherche plein texte (barre + portée + résultats + navigation).
import { el, debounce } from '../utils.js';
import { searchText } from '../search.js';
import { getBook, getAllBooks } from '../storage.js';

// onGoto({ bookId, pageIndex, normQuery, occ }) : déclenché à la sélection d'un résultat.
export function createSearchView({ currentBookId, onGoto, openBookIds = null }) {
  let curBookId = currentBookId;   // livre courant (peut changer : panneau focalisé en lecture double)
  const openIds = Array.isArray(openBookIds) ? openBookIds.filter(Boolean) : [];
  const isDual = openIds.length >= 2;   // le filtre « les 2 livres ouverts » n'a de sens qu'en lecture double
  let scope = 'book';                   // 'book' (sélectionné) | 'open' (2 ouverts) | 'all' (tous les importés)
  let results = [];
  let sel = -1;
  let normQuery = '';

  const input = el('input', {
    type: 'search', placeholder: 'Rechercher dans le texte…', class: 'search-input',
    autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    onInput: () => runSearch(),
    onKeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (results.length) select(0); }
      if (e.key === 'Escape') close();
    },
  });

  const scopeBook = el('button', { class: 'btn chip', text: 'Ce livre', 'aria-pressed': 'true',
    title: 'Chercher uniquement dans le PDF sélectionné', onClick: () => setScope('book') });
  const scopeOpen = isDual ? el('button', { class: 'btn chip', text: 'Les 2 livres', 'aria-pressed': 'false',
    title: 'Chercher dans les 2 PDF ouverts côte à côte', onClick: () => setScope('open') }) : null;
  const scopeAll = el('button', { class: 'btn chip', text: 'Tous les livres', 'aria-pressed': 'false',
    title: 'Chercher dans tous les PDF importés (ouverts ou non)', onClick: () => setScope('all') });

  const countLine = el('div', { class: 'search-count', text: '' });
  const ocrNote = el('div', { class: 'search-ocr-note', text: '', style: { display: 'none' } });
  const list = el('div', { class: 'search-results' });
  const prevBtn = el('button', { class: 'btn btn-icon', html: '↑', title: 'Résultat précédent', onClick: () => step(-1) });
  const nextBtn = el('button', { class: 'btn btn-icon', html: '↓', title: 'Résultat suivant', onClick: () => step(1) });
  const closeBtn = el('button', { class: 'btn btn-icon', html: '✕', title: 'Fermer', onClick: () => close() });

  const panel = el('div', { class: 'search-panel' }, [
    el('div', { class: 'search-row' }, [
      input, prevBtn, nextBtn, closeBtn,
    ]),
    el('div', { class: 'search-row search-row--meta' }, [
      el('span', { class: 'search-scope' }, [scopeBook, scopeOpen, scopeAll]),
      countLine,
    ]),
    ocrNote,
    list,
  ]);
  const element = el('div', { class: 'search-overlay hidden' }, [panel]);
  // clic hors du panneau = fermer
  element.addEventListener('pointerdown', (e) => { if (e.target === element) close(); });

  function setScope(s) {
    scope = s;
    scopeBook.setAttribute('aria-pressed', String(s === 'book'));
    if (scopeOpen) scopeOpen.setAttribute('aria-pressed', String(s === 'open'));
    scopeAll.setAttribute('aria-pressed', String(s === 'all'));
    runSearch();
  }

  const runSearch = debounce(async () => {
    const q = input.value;
    const res = await searchText(q, { scope, bookId: curBookId, openBookIds: openIds });
    normQuery = res.query;
    results = res.results;
    sel = -1;
    renderResults(res);
    // Indicateur OCR : si l'indexation/OCR tourne encore, prévenir que des résultats peuvent manquer.
    try {
      let books;
      if (scope === 'all') books = await getAllBooks();
      else if (scope === 'open') books = (await Promise.all(openIds.map((id) => getBook(id)))).filter(Boolean);
      else books = curBookId ? [await getBook(curBookId)].filter(Boolean) : [];
      const busy = books.some((b) => b && (b.ocrStatus === 'pending' || b.ocrStatus === 'running'));
      ocrNote.style.display = busy ? '' : 'none';
      ocrNote.textContent = busy ? '🔄 Indexation/OCR en cours — certains résultats peuvent encore manquer (réessaie dans un instant).' : '';
    } catch {}
  }, 220);

  function renderResults(res) {
    list.replaceChildren();
    if (!res.query) { countLine.textContent = ''; return; }
    if (!results.length) { countLine.textContent = 'Aucun résultat.'; return; }
    const pageWord = results.length > 1 ? 'pages' : 'page';
    countLine.textContent = `${res.totalOccurrences} occurrence${res.totalOccurrences > 1 ? 's' : ''} · ${results.length} ${pageWord}`;
    results.forEach((r, idx) => {
      const item = el('button', { class: 'search-item', onClick: () => select(idx) }, [
        el('div', { class: 'search-item__head' }, [
          scope !== 'book' ? el('span', { class: 'search-item__book', text: r.bookTitle }) : null,
          el('span', { class: 'search-item__page', text: `Page ${r.pageIndex + 1}` }),
          r.count > 1 ? el('span', { class: 'badge', text: `${r.count}×` }) : null,
        ]),
        el('div', { class: 'search-item__snippet', text: r.snippet }),
      ]);
      list.appendChild(item);
    });
  }

  function select(idx) {
    if (idx < 0 || idx >= results.length) return;
    sel = idx;
    [...list.children].forEach((c, i) => c.classList.toggle('search-item--active', i === idx));
    const r = results[idx];
    onGoto({ bookId: r.bookId, pageIndex: r.pageIndex, normQuery, occ: 0 });
  }
  function step(dir) {
    if (!results.length) return;
    let n = sel + dir;
    if (n < 0) n = results.length - 1;
    if (n >= results.length) n = 0;
    select(n);
    const node = list.children[n];
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    element.classList.remove('hidden');
    // Focus SYNCHRONE (dans le geste utilisateur) + reflow après le passage display:none→visible,
    // pour que le clavier iOS s'affiche (un focus différé ne le lève pas sur iPad/Safari).
    void element.offsetWidth;
    try { input.focus({ preventScroll: true }); } catch { try { input.focus(); } catch {} }
  }
  function close() { element.classList.add('hidden'); }
  function isOpen() { return !element.classList.contains('hidden'); }

  return { element, open, close, isOpen, setCurrentBook(id) { curBookId = id; }, destroy() {} };
}
