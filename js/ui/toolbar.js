// Barre d'outils de censure du lecteur.
import { el } from '../utils.js';
import { toast } from './dialogs.js';

const TOOLS = [
  { id: 'none', glyph: '✋', title: 'Lecture / déplacement (scroll, sélection texte)' },
  { id: 'rect', glyph: '▭', title: 'Censure : rectangle' },
  { id: 'lasso', glyph: '◌', title: 'Censure : forme libre (lasso)' },
  { id: 'highlight', glyph: '🖊️', title: 'Surligneur bleu (emphase — garde le texte visible, ≠ censure)' },
  { id: 'erase', glyph: '⌫', title: 'Gomme : effacer une censure' },
];

let hintShown = false; // conseil "stylet" affiché une seule fois par session

export function createToolbar({ pane }) {
  const buttons = {};
  function setActive(id) { for (const k in buttons) buttons[k].setAttribute('aria-pressed', String(k === id)); }

  const toolEls = TOOLS.map((t) => {
    const b = el('button', {
      class: 'tool', title: t.title, html: t.glyph,
      'aria-pressed': String(t.id === 'none'),
      onClick: () => {
        pane.setTool(t.id); setActive(t.id);
        if (!hintShown && t.id !== 'none') {
          hintShown = true;
          toast('✏️ Dessine avec l’Apple Pencil — le doigt fait défiler. (Gomme : tape une censure du doigt pour l’effacer.)', { duration: 4500 });
        }
      },
    });
    buttons[t.id] = b;
    return b;
  });

  const undoBtn = el('button', { class: 'tool', title: 'Annuler la dernière censure (page active)', html: '↶',
    onClick: () => { if (!pane.undoActivePage()) toast('Rien à annuler sur cette page.'); } });

  // ---- Zoom (− / 100% / +) : agit sur le panneau (les deux en mode double) ----
  function updateZoomLabel() {
    const z = (pane.getZoom ? pane.getZoom() : 1) || 1;
    zoomLabel.textContent = Math.round(z * 100) + ' %';
  }
  const zoomOut = el('button', { class: 'tool', title: 'Réduire (zoom −)', html: '−',
    onClick: () => { if (pane.zoomBy) pane.zoomBy(1 / 1.25); updateZoomLabel(); } });
  const zoomLabel = el('button', { class: 'btn zoom-label', title: 'Réinitialiser le zoom (ajuster à la largeur)',
    text: '100 %', onClick: () => { if (pane.resetZoom) pane.resetZoom(); updateZoomLabel(); } });
  const zoomIn = el('button', { class: 'tool', title: 'Agrandir (zoom +)', html: '+',
    onClick: () => { if (pane.zoomBy) pane.zoomBy(1.25); updateZoomLabel(); } });
  const zoomGroup = el('span', { class: 'zoom-group' }, [zoomOut, zoomLabel, zoomIn]);

  // rightSlot : rempli par les vues (progression, bouton « Censurer la page », notes vocales, export).
  const right = el('span', { class: 'toolbar__right' }, []);
  const element = el('div', { class: 'toolbar' }, [
    ...toolEls,
    el('span', { class: 'sep' }),
    undoBtn,
    el('span', { class: 'sep' }),
    zoomGroup,
    el('span', { class: 'spacer' }),
    right,
  ]);

  return {
    element,
    setActive,
    updateZoomLabel,
    rightSlot: right,   // pour y ajouter l'indicateur de progression (Phase 6)
    destroy() {},
  };
}
