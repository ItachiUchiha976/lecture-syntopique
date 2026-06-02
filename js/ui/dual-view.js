// Vue lecteur DOUBLE : deux PDF côte à côte (lecture syntopique).
// Une barre d'outils partagée agit sur le panneau "focalisé" (dernier touché).
// La censure et le suivi de lecture fonctionnent indépendamment pour chaque livre.
import { el } from '../utils.js';
import { navigate } from '../router.js';
import { openBookDoc } from '../book-doc.js';
import { destroyDoc } from '../pdf-engine.js';
import { createReaderPane } from './reader-pane.js';
import { createToolbar } from './toolbar.js';
import { toast, confirmDialog } from './dialogs.js';
import { computeCoverage } from '../coverage.js';
import { getSetting, getAllBooks } from '../storage.js';
import { indexBook, isIndexed } from '../text-indexer.js';
import { createReadingTracker } from '../reading-tracker.js';
import { createVoiceNotes } from './voice-notes.js';

export async function renderDual({ leftBookId, rightBookId }) {
  const left = await openBookDoc(leftBookId);
  const right = await openBookDoc(rightBookId);
  for (const b of [left.book, right.book]) if (!isIndexed(b)) indexBook(b).catch(() => {});

  const trackerL = createReadingTracker({ book: left.book });
  const trackerR = createReadingTracker({ book: right.book });

  const paneL = createReaderPane({ book: left.book, pdfDoc: left.pdfDoc, dual: true, onActivePage: (i) => trackerL.setActivePage(i) });
  const paneR = createReaderPane({ book: right.book, pdfDoc: right.pdfDoc, dual: true, onActivePage: (i) => trackerR.setActivePage(i) });

  let focused = 'L';
  const activePane = () => (focused === 'L' ? paneL : paneR);
  const activeBook = () => (focused === 'L' ? left.book : right.book);
  function setFocus(f) {
    focused = f;
    paneL.element.classList.toggle('reader--focus', f === 'L');
    paneR.element.classList.toggle('reader--focus', f === 'R');
    // Le zoom étant propre à chaque panneau, on rafraîchit l'indicateur % au changement de focus.
    if (toolbar && toolbar.updateZoomLabel) toolbar.updateZoomLabel();
    // Les notes vocales listées suivent le livre focalisé.
    if (voice && voice.isOpen()) voice.refresh();
  }
  paneL.element.addEventListener('pointerdown', () => setFocus('L'), true);
  paneR.element.addEventListener('pointerdown', () => setFocus('R'), true);

  // Outil appliqué aux DEUX panneaux (on peut dessiner dans l'un ou l'autre) ;
  // undo/vérifier agissent sur le panneau focalisé.
  const toolProxy = {
    setTool: (t) => { paneL.setTool(t); paneR.setTool(t); },
    undoActivePage: () => activePane().undoActivePage(),
    // Zoom INDÉPENDANT par panneau : agit sur le panneau focalisé (dernier touché),
    // ce qui permet p.ex. 100 % à gauche et 110 % à droite.
    getZoom: () => activePane().getZoom(),
    zoomBy: (f) => activePane().zoomBy(f),
    resetZoom: () => activePane().resetZoom(),
  };

  async function onVerify() {
    const pane = activePane();
    const i = pane.getActivePageIndex();
    if (i < 0) { toast('Page non détectée.'); return; }
    const size = pane.getNativeSize(i);
    const marks = pane.getCensorMarks(i) || [];
    if (!size) { toast('Page pas encore prête.'); return; }
    if (pane.isPageCensored(i)) {
      const undo = await confirmDialog({ title: `Page ${i + 1} déjà censurée`, message: 'La rétablir ?', okText: 'Rétablir', cancelText: 'Garder' });
      if (undo) pane.setPageCensored(i, false);
      return;
    }
    if (!marks.length) { toast('Aucune censure sur cette page.'); return; }
    const cov = computeCoverage(marks, size.w, size.h);
    const pct = Math.round(cov * 100);
    const threshold = await getSetting('coverageThreshold');
    if (cov >= 0.995) { pane.setPageCensored(i, true); toast(`Page ${i + 1} entièrement censurée.`); }
    else if (cov > threshold) {
      const ok = await confirmDialog({ title: `Page ${i + 1} censurée à ${pct} %`,
        message: `Censurer toute la page ? (réversible)`, okText: 'Oui', cancelText: 'Non' });
      if (ok) pane.setPageCensored(i, true);
    } else { toast(`Page ${i + 1} censurée à ${pct} % (seuil non atteint).`); }
  }

  const toolbar = createToolbar({ pane: toolProxy, onVerify });

  // ---- Notes vocales : rattachées au panneau focalisé, en gardant les 2 côtés en contexte ----
  const voice = createVoiceNotes({
    getContext: () => {
      const L = { bookId: left.book.id, title: left.book.title, pageIndex: paneL.getActivePageIndex() };
      const R = { bookId: right.book.id, title: right.book.title, pageIndex: paneR.getActivePageIndex() };
      const primary = focused === 'L' ? L : R;
      return { bookId: primary.bookId, pageIndex: primary.pageIndex, title: primary.title,
        context: { mode: 'dual', focused, left: L, right: R } };
    },
  });
  toolbar.rightSlot.append(voice.button);

  // ---- Échange rapide d'un des deux livres (comparer un livre-ancre contre plusieurs sources) ----
  async function pickBook(title, onPick) {
    const others = (await getAllBooks()).filter((b) => b.id !== left.book.id && b.id !== right.book.id);
    if (!others.length) { toast('Aucun autre livre à comparer. Importe-en un.'); return; }
    const overlay = el('div', { class: 'overlay' });
    const close = () => overlay.remove();
    const list = el('div', { class: 'compare-list' }, others.map((b) =>
      el('button', { class: 'btn', text: b.title, onClick: () => { close(); onPick(b.id); } })));
    overlay.appendChild(el('div', { class: 'dialog' }, [
      el('h3', { text: title }), list,
      el('div', { class: 'dialog__actions' }, [el('button', { class: 'btn btn--ghost', text: 'Annuler', onClick: close })]),
    ]));
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }
  const swapL = el('button', { class: 'btn btn-icon dual-swap', html: '⇄', title: 'Changer le livre de gauche',
    onClick: () => pickBook('Remplacer le livre de gauche par…', (id) => navigate('dual', { leftBookId: id, rightBookId: right.book.id })) });
  const swapR = el('button', { class: 'btn btn-icon dual-swap', html: '⇄', title: 'Changer le livre de droite',
    onClick: () => pickBook('Remplacer le livre de droite par…', (id) => navigate('dual', { leftBookId: left.book.id, rightBookId: id })) });

  const backBtn = el('button', { class: 'btn btn-icon', html: '‹', title: 'Retour', onClick: () => navigate('library') });
  const titleL = el('span', { class: 'dual-title', text: left.book.title, title: left.book.title });
  const titleR = el('span', { class: 'dual-title', text: right.book.title, title: right.book.title });
  const header = el('header', { class: 'app-header' }, [
    backBtn,
    el('span', { class: 'title', html: '▦ Lecture double' }),
    el('span', { class: 'spacer' }),
  ]);

  const dual = el('div', { class: 'dual' }, [
    el('div', { class: 'dual-col' }, [el('div', { class: 'dual-col__head' }, [titleL, swapL]), paneL.element]),
    el('div', { class: 'dual-col' }, [el('div', { class: 'dual-col__head' }, [titleR, swapR]), paneR.element]),
  ]);

  const element = el('div', { class: 'view' }, [header, toolbar.element, dual, voice.panel]);
  setFocus('L');

  await trackerL.init();
  await trackerR.init();

  return {
    element,
    destroy() {
      try { trackerL.destroy(); } catch {}
      try { trackerR.destroy(); } catch {}
      try { toolbar.destroy(); } catch {}
      try { paneL.destroy(); } catch {}
      try { paneR.destroy(); } catch {}
      try { destroyDoc(left.pdfDoc); } catch {}
      try { destroyDoc(right.pdfDoc); } catch {}
    },
  };
}
