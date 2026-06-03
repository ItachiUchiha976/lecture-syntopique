// Vue lecteur (un seul PDF) : en-tête + barre d'outils + recherche + lecteur,
// avec suivi de lecture (anti-triche) et déblocage de l'export.
import { el, formatReadingProgress } from '../utils.js';
import { navigate } from '../router.js';
import { openBookDoc } from '../book-doc.js';
import { destroyDoc } from '../pdf-engine.js';
import { createReaderPane } from './reader-pane.js';
import { createSearchView } from './search-view.js';
import { createToolbar } from './toolbar.js';
import { toast, promptDialog } from './dialogs.js';
import { getProgress, getBook } from '../storage.js';
import { indexBook, isIndexed } from '../text-indexer.js';
import { ensureBookSearchable } from './ocr-gate.js';
import { createReadingTracker } from '../reading-tracker.js';
import { runExportFlow } from './export-flow.js';
import { createVoiceNotes } from './voice-notes.js';

export async function renderReader({ bookId, gotoPage = null, highlightQuery = null }) {
  // Verrou OCR : un PDF scanné doit être cherchable AVANT lecture. Couvre aussi le rechargement de
  // l'app directement sur cette route (qui court-circuite le verrou de la bibliothèque). Idempotent :
  // instantané pour un PDF natif ou déjà reconnu.
  const book0 = await getBook(bookId);
  if (book0 && !(await ensureBookSearchable(book0))) {
    // « Retour à la bibliothèque » : on y revient (différé pour ne pas perturber le routeur en plein montage).
    setTimeout(() => navigate('library', {}, { replace: true }), 0);
    return { element: el('div', { class: 'view' }), destroy() {} };
  }
  const { book, pdfDoc } = await openBookDoc(bookId);
  if (!isIndexed(book)) indexBook(book).catch((e) => console.warn('[index]', e));

  const tracker = createReadingTracker({ book, onProgress: updateProgressUI });
  const pane = createReaderPane({
    book, pdfDoc, dual: false,
    onActivePage: (i) => { tracker.setActivePage(i); updatePageLabel(i); refreshCensorBtn(); },
    onCensoredChange: (i) => { if (i === pane.getActivePageIndex()) refreshCensorBtn(); },
  });

  // ---- Aller à une page (saut direct, sans scroller longtemps) ----
  function updatePageLabel(i) { if (gotoBtn) gotoBtn.textContent = `p.${(i || 0) + 1}`; }
  async function gotoPage() {
    const v = await promptDialog({ title: 'Aller à la page', message: `Numéro de page (1 à ${book.pageCount}) :`, type: 'number', okText: 'Aller' });
    if (v == null) return;
    const n = parseInt(String(v).trim(), 10);
    if (!n || n < 1 || n > book.pageCount) { toast('Numéro de page invalide.'); return; }
    pane.scrollToPage(n - 1);
    pane.clearHighlights(); // saut de page volontaire → on retire le surlignage de recherche
  }
  const gotoBtn = el('button', { class: 'btn goto-page', text: 'p.1', title: 'Aller à une page…', onClick: () => gotoPage() });

  // ---- Censurer / Rétablir la page en cours de lecture (page active) ----
  // Remplace l'ancienne détection auto à 80 % (peu fiable) par une action explicite et réversible.
  const censorBtn = el('button', { class: 'btn', onClick: () => {
    const i = pane.getActivePageIndex();
    if (i < 0) { toast('Page non détectée.'); return; }
    pane.setPageCensored(i, !pane.isPageCensored(i));
    refreshCensorBtn();
  } });
  function refreshCensorBtn() {
    const i = pane.getActivePageIndex();
    const on = i >= 0 && pane.isPageCensored(i);
    censorBtn.textContent = on ? 'Rétablir la page' : 'Censurer la page';
    censorBtn.title = on
      ? 'Afficher de nouveau cette page (annule la censure)'
      : 'Masquer entièrement cette page — supprimée du PDF exporté (réversible à tout moment)';
    censorBtn.classList.toggle('btn--primary', on);
  }

  async function onExport() {
    if (!tracker.bookRead) {
      toast('Termine d’abord la lecture du livre pour débloquer l’export.');
      return;
    }
    await runExportFlow({ book });
  }

  const toolbar = createToolbar({ pane });
  toolbar.rightSlot.append(censorBtn);
  refreshCensorBtn();

  // ---- Notes vocales de connexion (audio rattaché à la page active) ----
  const voice = createVoiceNotes({
    getContext: () => {
      const pageIndex = pane.getActivePageIndex();
      return {
        bookId, pageIndex, title: book.title,
        context: { mode: 'single', left: { bookId, title: book.title, pageIndex } },
      };
    },
  });
  toolbar.rightSlot.append(voice.button);

  // ---- Indicateur de progression + bouton Export ----
  const fill = el('span');
  const bar = el('span', { class: 'progress-line bar' }, [fill]);
  const pctLabel = el('span', { class: 'pct', text: '0 %' });
  const progressEl = el('span', { class: 'read-progress', title: 'Progression de lecture réelle' }, [bar, pctLabel]);
  const exportBtn = el('button', { class: 'btn', text: 'Exporter', disabled: '', onClick: () => onExport() });
  toolbar.rightSlot.prepend(progressEl);
  toolbar.rightSlot.append(exportBtn);

  function updateProgressUI({ fraction, bookRead, pagesSatisfied, totalPages, remainingMs = 0, pagesRemaining = 0 }) {
    const p = Math.round(fraction * 100);
    fill.style.width = p + '%';
    const info = formatReadingProgress({ fraction, bookRead, remainingMs, pagesRemaining });
    pctLabel.textContent = info.label;
    progressEl.title = info.title;
    if (bookRead) {
      exportBtn.disabled = false;
      exportBtn.classList.add('btn--primary');
      exportBtn.title = 'Exporter le PDF filtré (pages censurées supprimées)';
    } else {
      exportBtn.disabled = true;
      exportBtn.classList.remove('btn--primary');
      // Indique combien de pages il reste à lire (anti-triche : 98 % des pages requises).
      const need = Math.max(1, Math.ceil((totalPages || 0) * 0.98));
      const remaining = Math.max(0, need - (pagesSatisfied || 0));
      exportBtn.title = remaining
        ? `Encore ~${remaining} page${remaining > 1 ? 's' : ''} à lire pour débloquer l’export`
        : 'Continue ta lecture pour débloquer l’export';
    }
  }

  const search = createSearchView({
    currentBookId: bookId,
    onGoto: ({ bookId: bid, pageIndex, normQuery, occ }) => {
      if (bid === bookId) { search.close(); pane.highlightQuery(pageIndex, normQuery, occ); }
      else navigate('reader', { bookId: bid, gotoPage: pageIndex, highlightQuery: normQuery });
    },
  });

  const backBtn = el('button', { class: 'btn btn-icon', html: '‹', title: 'Retour à la bibliothèque',
    onClick: () => navigate('library') });
  const searchBtn = el('button', { class: 'btn btn-icon', html: '🔍', title: 'Rechercher',
    onClick: () => {
      if (search.isOpen()) { search.close(); return; }
      // Rouvrir la recherche efface le surlignage précédent (« jusqu'à ce que je quitte la recherche »).
      pane.clearHighlights();
      search.open();
    } });
  const header = el('header', { class: 'app-header' }, [
    backBtn,
    el('span', { class: 'title', text: book.title, title: book.title,
      style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '38vw' } }),
    el('span', { class: 'spacer' }),
    gotoBtn,
    searchBtn,
  ]);

  const element = el('div', { class: 'view' }, [header, toolbar.element, pane.element, search.element, voice.panel]);

  await tracker.init();

  if (gotoPage != null) {
    setTimeout(() => {
      if (highlightQuery) pane.highlightQuery(gotoPage, highlightQuery, 0);
      else pane.scrollToPage(gotoPage);
    }, 150);
  } else {
    // Reprise : rouvrir à la dernière page lue (si on n'arrive pas via la recherche).
    try {
      const prog = await getProgress(bookId);
      if (prog && prog.lastPageIndex > 0) setTimeout(() => pane.scrollToPage(prog.lastPageIndex), 150);
    } catch {}
  }

  return {
    element,
    destroy() {
      try { tracker.destroy(); } catch {}
      try { search.destroy(); } catch {}
      try { voice.destroy(); } catch {}
      try { toolbar.destroy(); } catch {}
      try { pane.destroy(); } catch {}
      try { destroyDoc(pdfDoc); } catch {}
    },
  };
}
