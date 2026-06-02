// Vue lecteur (un seul PDF) : en-tête + barre d'outils + recherche + lecteur,
// avec suivi de lecture (anti-triche) et déblocage de l'export.
import { el } from '../utils.js';
import { navigate } from '../router.js';
import { openBookDoc } from '../book-doc.js';
import { destroyDoc } from '../pdf-engine.js';
import { createReaderPane } from './reader-pane.js';
import { createSearchView } from './search-view.js';
import { createToolbar } from './toolbar.js';
import { toast, confirmDialog, promptDialog } from './dialogs.js';
import { computeCoverage } from '../coverage.js';
import { getSetting, getProgress } from '../storage.js';
import { indexBook, isIndexed } from '../text-indexer.js';
import { createReadingTracker } from '../reading-tracker.js';
import { runExportFlow } from './export-flow.js';
import { createVoiceNotes } from './voice-notes.js';

export async function renderReader({ bookId, gotoPage = null, highlightQuery = null }) {
  const { book, pdfDoc } = await openBookDoc(bookId);
  if (!isIndexed(book)) indexBook(book).catch((e) => console.warn('[index]', e));

  const tracker = createReadingTracker({ book, onProgress: updateProgressUI });
  const pane = createReaderPane({ book, pdfDoc, dual: false, onActivePage: (i) => { tracker.setActivePage(i); updatePageLabel(i); } });

  // ---- Aller à une page (saut direct, sans scroller longtemps) ----
  function updatePageLabel(i) { if (gotoBtn) gotoBtn.textContent = `p.${(i || 0) + 1}`; }
  async function gotoPage() {
    const v = await promptDialog({ title: 'Aller à la page', message: `Numéro de page (1 à ${book.pageCount}) :`, type: 'number', okText: 'Aller' });
    if (v == null) return;
    const n = parseInt(String(v).trim(), 10);
    if (!n || n < 1 || n > book.pageCount) { toast('Numéro de page invalide.'); return; }
    pane.scrollToPage(n - 1);
  }
  const gotoBtn = el('button', { class: 'btn goto-page', text: 'p.1', title: 'Aller à une page…', onClick: () => gotoPage() });

  // ---- Vérifier la censure (page active) ----
  async function onVerify() {
    const i = pane.getActivePageIndex();
    if (i < 0) { toast('Page non détectée.'); return; }
    const size = pane.getNativeSize(i);
    const marks = pane.getCensorMarks(i) || [];
    if (!size) { toast('Page pas encore prête, réessaie.'); return; }
    if (pane.isPageCensored(i)) {
      const undo = await confirmDialog({ title: `Page ${i + 1} déjà censurée`,
        message: 'Cette page est marquée comme entièrement censurée. Veux-tu la rétablir ?',
        okText: 'Rétablir', cancelText: 'Garder censurée' });
      if (undo) pane.setPageCensored(i, false);
      return;
    }
    if (!marks.length) { toast('Aucune censure sur cette page pour l’instant.'); return; }
    const cov = computeCoverage(marks, size.w, size.h);
    const pct = Math.round(cov * 100);
    const threshold = await getSetting('coverageThreshold');
    const thr = Math.round(threshold * 100);
    if (cov >= 0.995) {
      pane.setPageCensored(i, true);
      toast(`Page ${i + 1} entièrement censurée → marquée comme censurée.`);
    } else if (cov > threshold) {
      const ok = await confirmDialog({
        title: `Page ${i + 1} censurée à ${pct} %`,
        message: `Tu as masqué plus de ${thr} % de cette page.\nVeux-tu la censurer entièrement ? (réversible à tout moment)`,
        okText: 'Oui, censurer la page', cancelText: 'Non',
      });
      if (ok) { pane.setPageCensored(i, true); toast(`Page ${i + 1} marquée comme censurée.`); }
    } else {
      toast(`Page ${i + 1} censurée à ${pct} % (seuil de ${thr} % non atteint).`);
    }
  }

  async function onExport() {
    if (!tracker.bookRead) {
      toast('Termine d’abord la lecture du livre pour débloquer l’export.');
      return;
    }
    await runExportFlow({ book });
  }

  const toolbar = createToolbar({ pane, onVerify });

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

  function updateProgressUI({ fraction, bookRead }) {
    const p = Math.round(fraction * 100);
    fill.style.width = p + '%';
    pctLabel.textContent = p + ' % lu';
    if (bookRead) {
      exportBtn.disabled = false;
      exportBtn.classList.add('btn--primary');
      exportBtn.title = 'Exporter le PDF filtré (pages censurées supprimées)';
    } else {
      exportBtn.disabled = true;
      exportBtn.classList.remove('btn--primary');
      exportBtn.title = 'Termine la lecture du livre pour débloquer l’export';
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
    onClick: () => (search.isOpen() ? search.close() : search.open()) });
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
