// Couche de censure d'UNE page : canvas superposé où l'on dessine les masques.
// Outils : rectangle, lasso (forme libre), surligneur de texte, gomme.
// La censure est RÉSERVÉE AU STYLET (Apple Pencil) via Pointer Events ; le doigt,
// lui, sert UNIQUEMENT à faire défiler la page. Pendant un tracé au stylet, le
// défilement est verrouillé (onDrawingChange) : la paume posée ne fait pas bouger
// la page sous le dessin (palm rejection).
// Les formes sont stockées en UNITÉS PDF (origine haut-gauche, points PDF),
// indépendamment du zoom / de la résolution d'affichage.
import { el, uuid } from './utils.js';
import { simplifyPath, tracePath, pointInPolygon } from './stroke-smoothing.js';

const FILL = 'rgba(11, 18, 32, 0.95)';        // censure validée (quasi noir opaque)
const PREVIEW = 'rgba(11, 18, 32, 0.55)';     // aperçu pendant le tracé

export function createCensorLayer({ wrap, cssW, cssH, nativeW, nativeH, getTextDivs, getTool, initialMarks, onCommit, onDrawingChange }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = el('canvas', { class: 'censor-layer' });
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const dispScale = cssW / nativeW;             // CSS px par unité PDF
  const toCss = (u) => u * dispScale;
  const toPdf = (px) => px / dispScale;

  let marks = (initialMarks || []).slice();

  // État de dessin
  let drawing = false;
  let startPt = null;
  let points = [];                              // points CSS du tracé en cours
  let touched = new Set();                      // indices de spans touchés (surligneur)
  let previewRect = null;                       // rect CSS en cours

  function divRectCss(idx) {
    const d = getTextDivs()[idx];
    if (!d) return null;
    return { x: d.offsetLeft, y: d.offsetTop, w: d.offsetWidth, h: d.offsetHeight };
  }

  function drawMark(m) {
    if (m.type === 'rect') {
      ctx.fillRect(toCss(m.rect.x), toCss(m.rect.y), toCss(m.rect.w), toCss(m.rect.h));
    } else if (m.type === 'highlight') {
      for (const q of m.quads) ctx.fillRect(toCss(q.x), toCss(q.y), toCss(q.w), toCss(q.h));
    } else if (m.type === 'lasso' && m.path && m.path.length > 1) {
      ctx.beginPath();
      tracePath(ctx, m.path.map((p) => ({ x: toCss(p.x), y: toCss(p.y) })));
      ctx.closePath();
      ctx.fill();
    }
  }

  function redraw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = FILL;
    for (const m of marks) drawMark(m);
    if (drawing) {
      ctx.fillStyle = PREVIEW;
      const tool = getTool();
      if (tool === 'rect' && previewRect) {
        ctx.fillRect(previewRect.x, previewRect.y, previewRect.w, previewRect.h);
      } else if (tool === 'lasso' && points.length) {
        ctx.beginPath(); tracePath(ctx, points); ctx.closePath(); ctx.fill();
      } else if (tool === 'highlight') {
        for (const idx of touched) { const r = divRectCss(idx); if (r) ctx.fillRect(r.x, r.y, r.w, r.h); }
      }
    }
  }

  // ---- Interaction ----
  function localPt(e) { return { x: e.offsetX, y: e.offsetY }; }

  function rectFrom(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function addTouchedAt(p) {
    const divs = getTextDivs();
    for (let i = 0; i < divs.length; i++) {
      const d = divs[i];
      if (p.x >= d.offsetLeft && p.x <= d.offsetLeft + d.offsetWidth &&
          p.y >= d.offsetTop && p.y <= d.offsetTop + d.offsetHeight) {
        touched.add(i);
      }
    }
  }

  function eraseAt(p) {
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      let hit = false;
      if (m.type === 'rect') {
        const r = m.rect;
        hit = p.x >= toCss(r.x) && p.x <= toCss(r.x + r.w) && p.y >= toCss(r.y) && p.y <= toCss(r.y + r.h);
      } else if (m.type === 'highlight') {
        hit = m.quads.some((q) => p.x >= toCss(q.x) && p.x <= toCss(q.x + q.w) && p.y >= toCss(q.y) && p.y <= toCss(q.y + q.h));
      } else if (m.type === 'lasso') {
        hit = pointInPolygon(toPdf(p.x), toPdf(p.y), m.path);
      }
      if (hit) { marks.splice(i, 1); commit(); return true; }
    }
    return false;
  }

  function commit() { redraw(); onCommit(marks.slice()); }

  function onDown(e) {
    const tool = getTool();
    if (!tool || tool === 'none' || tool === 'pan') return;
    // Censure réservée au stylet (Apple Pencil). Le doigt (pointerType 'touch') est
    // ignoré ici : on le laisse passer SANS preventDefault ni capture pour que le
    // défilement natif de la page fonctionne (la couche a touch-action: pan-y).
    // La souris reste autorisée pour les tests sur ordinateur (pas de stylet sur PC).
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const p = localPt(e);
    if (tool === 'erase') { eraseAt(p); return; }
    drawing = true; startPt = p; points = [p]; touched = new Set(); previewRect = null;
    if (onDrawingChange) onDrawingChange(true); // verrouille le scroll pendant le tracé (palm rejection)
    if (tool === 'highlight') addTouchedAt(p);
    redraw();
  }
  function onMove(e) {
    if (!drawing) return;
    e.preventDefault();
    const tool = getTool();
    const p = localPt(e);
    if (tool === 'rect') previewRect = rectFrom(startPt, p);
    else if (tool === 'lasso') points.push(p);
    else if (tool === 'highlight') { points.push(p); addTouchedAt(p); }
    redraw();
  }
  function onUp(e) {
    if (!drawing) return;
    drawing = false;
    if (onDrawingChange) onDrawingChange(false);
    const tool = getTool();
    const p = localPt(e);
    if (tool === 'rect') {
      const r = rectFrom(startPt, p);
      if (r.w > 4 && r.h > 4) marks.push({ id: uuid(), type: 'rect', rect: { x: toPdf(r.x), y: toPdf(r.y), w: toPdf(r.w), h: toPdf(r.h) } });
    } else if (tool === 'lasso') {
      const simp = simplifyPath(points, 2);
      if (simp.length > 2) marks.push({ id: uuid(), type: 'lasso', path: simp.map((q) => ({ x: toPdf(q.x), y: toPdf(q.y) })) });
    } else if (tool === 'highlight') {
      const quads = [...touched].map(divRectCss).filter(Boolean)
        .map((r) => ({ x: toPdf(r.x), y: toPdf(r.y), w: toPdf(r.w), h: toPdf(r.h) }));
      if (quads.length) marks.push({ id: uuid(), type: 'highlight', quads });
    }
    previewRect = null; points = []; touched = new Set();
    commit();
  }
  function onCancel() { drawing = false; if (onDrawingChange) onDrawingChange(false); previewRect = null; points = []; touched = new Set(); redraw(); }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  redraw();

  return {
    canvas,
    redraw,
    getMarks: () => marks.slice(),
    setMarks: (m) => { marks = (m || []).slice(); redraw(); },
    undo: () => { if (marks.length) { marks.pop(); commit(); return true; } return false; },
    clear: () => { if (marks.length) { marks = []; commit(); } },
    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.remove();
    },
  };
}
