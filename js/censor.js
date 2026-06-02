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
const MARKER_CSS_W = 18;                       // épaisseur du surligneur "marqueur" (px CSS)

// Distance d'un point à un segment, et à une polyligne (pour effacer un trait de marqueur).
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function nearPolyline(p, pts, tol) {
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= tol;
  for (let k = 0; k < pts.length - 1; k++) {
    if (distToSeg(p.x, p.y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) <= tol) return true;
  }
  return false;
}

export function createCensorLayer({ wrap, cssW, cssH, nativeW, nativeH, getTextDivs, getTool, initialMarks, onCommit, onDrawingChange }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = el('canvas', { class: 'censor-layer' });
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const scroller = wrap.closest('.pages-scroller'); // pour le défilement au doigt (touch-action:none)

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
  // Défilement au doigt : la couche active est en touch-action:none (pour que le STYLET
  // dessine au lieu de scroller) ; on gère donc le défilement du doigt nous-mêmes.
  let panning = false;
  let panMoved = false;                          // le doigt a-t-il bougé (scroll) ou est-ce un simple tap ?
  let panStartY = 0, panStartX = 0, panTop = 0, panLeft = 0;

  function divRectCss(idx) {
    const d = getTextDivs()[idx];
    if (!d) return null;
    return { x: d.offsetLeft, y: d.offsetTop, w: d.offsetWidth, h: d.offsetHeight };
  }

  // Trace une polyligne épaisse (marqueur), couleur = fillStyle courant (FILL ou PREVIEW).
  function strokePath(ptsCss, widthCss) {
    if (!ptsCss.length) return;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = widthCss; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(ptsCss[0].x, ptsCss[0].y);
    for (let k = 1; k < ptsCss.length; k++) ctx.lineTo(ptsCss[k].x, ptsCss[k].y);
    if (ptsCss.length === 1) ctx.lineTo(ptsCss[0].x + 0.1, ptsCss[0].y);
    ctx.stroke();
    ctx.restore();
  }

  function drawMark(m) {
    if (m.type === 'rect') {
      ctx.fillRect(toCss(m.rect.x), toCss(m.rect.y), toCss(m.rect.w), toCss(m.rect.h));
    } else if (m.type === 'highlight') { // ancien surligneur (quads) — compat. ascendante
      for (const q of m.quads) ctx.fillRect(toCss(q.x), toCss(q.y), toCss(q.w), toCss(q.h));
    } else if (m.type === 'marker' && m.path && m.path.length) {
      strokePath(m.path.map((p) => ({ x: toCss(p.x), y: toCss(p.y) })), toCss(m.width || 0) || MARKER_CSS_W);
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
      } else if (tool === 'highlight' && points.length) {
        strokePath(points, MARKER_CSS_W);
      }
    }
  }

  // ---- Interaction ----
  // On utilise getBoundingClientRect + clientX/Y (et NON e.offsetX/Y) : sur Safari, offsetX
  // devient peu fiable quand le pointeur est capturé (relatif à l'écran) → la censure
  // « ratait » le côté droit d'une page centrée et le surligneur ne trouvait pas le texte.
  function localPt(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

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
      } else if (m.type === 'marker' && m.path) {
        const tol = (toCss(m.width || 0) || MARKER_CSS_W) / 2 + 6;
        hit = nearPolyline(p, m.path.map((pt) => ({ x: toCss(pt.x), y: toCss(pt.y) })), tol);
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
    // La censure est réservée au STYLET (Apple Pencil) et à la souris (tests PC).
    // Le DOIGT (pointerType 'touch') ne dessine jamais : il sert à faire défiler.
    // Comme la couche est en touch-action:none (indispensable pour que le stylet dessine
    // au lieu de scroller sur iPad), on gère le défilement au doigt manuellement ici.
    if (e.pointerType === 'touch') {
      if (drawing) return;                       // palm rejection : un tracé stylet est en cours
      if (!scroller) return;
      panning = true; panMoved = false;
      panStartY = e.clientY; panStartX = e.clientX;
      panTop = scroller.scrollTop; panLeft = scroller.scrollLeft;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const p = localPt(e);
    if (tool === 'erase') { eraseAt(p); return; }
    drawing = true; startPt = p; points = [p]; touched = new Set(); previewRect = null;
    if (onDrawingChange) onDrawingChange(true); // verrouille le scroll pendant le tracé (palm rejection)
    redraw();
  }
  function onMove(e) {
    if (panning) {
      const dx = e.clientX - panStartX, dy = e.clientY - panStartY;
      if (!panMoved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) panMoved = true;
      if (scroller) { scroller.scrollTop = panTop - dy; scroller.scrollLeft = panLeft - dx; }
      return;
    }
    if (!drawing) return;
    e.preventDefault();
    const tool = getTool();
    const p = localPt(e);
    if (tool === 'rect') previewRect = rectFrom(startPt, p);
    else if (tool === 'lasso') points.push(p);
    else if (tool === 'highlight') points.push(p);
    redraw();
  }
  function onUp(e) {
    if (panning) {
      panning = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      // Tap du doigt (sans glisser) en mode gomme = effacer LA censure touchée (pas toutes).
      if (!panMoved && getTool() === 'erase') eraseAt(localPt(e));
      return;
    }
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
      // Surligneur "marqueur" : trait épais le long du tracé (robuste, marche aussi sur PDF scannés).
      const simp = simplifyPath(points, 2);
      if (simp.length >= 2) marks.push({ id: uuid(), type: 'marker',
        path: simp.map((q) => ({ x: toPdf(q.x), y: toPdf(q.y) })), width: toPdf(MARKER_CSS_W) });
    }
    previewRect = null; points = []; touched = new Set();
    commit();
  }
  function onCancel() { panning = false; drawing = false; if (onDrawingChange) onDrawingChange(false); previewRect = null; points = []; touched = new Set(); redraw(); }

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
