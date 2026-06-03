// Couche de censure d'UNE page : canvas superposé où l'on dessine les masques.
// Outils : rectangle, lasso (forme libre), surligneur (marqueur bleu), gomme.
//
// La censure est RÉSERVÉE AU STYLET (Apple Pencil) via Pointer Events ; le DOIGT
// sert UNIQUEMENT à faire défiler (et, en mode gomme, à effacer une censure d'un tap).
// La couche active est en `touch-action: none` (indispensable pour que le stylet
// DESSINE au lieu de scroller sur iPad) ; le défilement au doigt est donc géré
// manuellement ici, AVEC inertie (momentum) au lever pour rester confortable.
//
// Robustesse multi-touch : on suit l'identité des pointeurs (penId / panId). Le stylet
// a TOUJOURS la priorité ; si un doigt/une paume a commencé un défilement avant le
// stylet, on l'abandonne proprement (plus de tracé « transformé en scroll », plus de
// censure parasite au lever de la paume). Pendant un tracé stylet, tout doigt est ignoré.
//
// Mémoire : la couche est rendue en DPR 1 (des aplats/traits n'ont pas besoin du Retina)
// → ÷4 sur son empreinte canvas (important en lecture double + zoom sur iPad).
//
// Les formes sont stockées en UNITÉS PDF (origine haut-gauche), indépendamment du
// zoom / de la résolution d'affichage.
import { el, uuid } from './utils.js';
import { simplifyPath, tracePath, pointInPolygon } from './stroke-smoothing.js';

const FILL = 'rgba(11, 18, 32, 0.95)';        // censure validée (quasi noir opaque)
const PREVIEW = 'rgba(11, 18, 32, 0.55)';     // aperçu pendant le tracé
const MARKER_CSS_W = 18;                       // épaisseur du surligneur "marqueur" (px CSS)
const MARKER_COLOR = 'rgba(37, 99, 235, 0.32)';   // surligneur BLEU translucide (texte visible, ≠ censure noire)
const MARKER_PREVIEW = 'rgba(37, 99, 235, 0.22)';

// Réglages de l'inertie (momentum) du défilement au doigt.
const FLICK_MIN_V = 0.05;   // px/ms : en-dessous, pas de relance (simple dépose)
const STOP_V      = 0.02;   // px/ms : on stoppe l'animation sous ce seuil
const FRICTION    = 0.95;   // décroissance par 16,67 ms (~60 fps)

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

export function createCensorLayer({ wrap, cssW, cssH, nativeW, nativeH, getTool, initialMarks, onCommit, onDrawingChange }) {
  const dpr = 1; // basse résolution : aplats/traits n'ont pas besoin du Retina → ÷4 mémoire canvas (iPad)
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

  // État de dessin (stylet)
  let drawing = false;
  let penId = null;                              // pointerId du stylet/souris qui dessine
  let startPt = null;
  let points = [];                              // points CSS du tracé en cours
  let previewRect = null;                       // rect CSS en cours

  // État de défilement au doigt (touch-action:none → géré manuellement, avec inertie)
  let panning = false;
  let panId = null;                              // pointerId du doigt qui fait défiler
  let panMoved = false;                          // le doigt a-t-il bougé (scroll) ou est-ce un simple tap ?
  let panStartY = 0, panStartX = 0, panTop = 0, panLeft = 0;
  // Suivi de vitesse pour l'inertie
  let panLastT = 0, panLastX = 0, panLastY = 0;
  let panVX = 0, panVY = 0;                      // vitesse du doigt (px/ms)
  let momentumRAF = 0;

  const nowMs = (e) => (e && e.timeStamp) || performance.now();

  // Trace une polyligne épaisse (marqueur), couleur = fillStyle courant (FILL ou PREVIEW).
  function strokePath(ptsCss, widthCss, color) {
    if (!ptsCss.length) return;
    ctx.save();
    ctx.strokeStyle = color || ctx.fillStyle;
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
      strokePath(m.path.map((p) => ({ x: toCss(p.x), y: toCss(p.y) })), toCss(m.width || 0) || MARKER_CSS_W, MARKER_COLOR);
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
        strokePath(points, MARKER_CSS_W, MARKER_PREVIEW);
      }
    }
  }

  // ---- Interaction ----
  // getBoundingClientRect + clientX/Y (et NON e.offsetX/Y, peu fiable sous capture sur Safari).
  function localPt(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function rectFrom(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
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

  // ---- Inertie du défilement au doigt ----
  function cancelMomentum() { if (momentumRAF) { cancelAnimationFrame(momentumRAF); momentumRAF = 0; } }
  function startMomentum() {
    cancelMomentum();
    if (!scroller) return;
    if (Math.abs(panVX) < FLICK_MIN_V && Math.abs(panVY) < FLICK_MIN_V) return; // dépose, pas un flick
    let last = performance.now();
    const step = (t) => {
      const dt = t - last; last = t;
      const decay = Math.pow(FRICTION, dt / 16.67);
      panVX *= decay; panVY *= decay;
      if (Math.abs(panVX) < STOP_V && Math.abs(panVY) < STOP_V) { momentumRAF = 0; return; }
      const beforeTop = scroller.scrollTop, beforeLeft = scroller.scrollLeft;
      // Le contenu défile à l'opposé du doigt : d(scrollTop)/dt = -vitesseDoigtY.
      scroller.scrollTop  -= panVY * dt;
      scroller.scrollLeft -= panVX * dt;
      if (scroller.scrollTop === beforeTop && scroller.scrollLeft === beforeLeft) { momentumRAF = 0; return; } // butée
      momentumRAF = requestAnimationFrame(step);
    };
    momentumRAF = requestAnimationFrame(step);
  }

  // ---- Pointer Events ----
  function onDown(e) {
    const tool = getTool();
    if (!tool || tool === 'none' || tool === 'pan') return;
    cancelMomentum(); // tout nouveau contact stoppe l'inertie en cours (on peut "rattraper" un fling)

    if (e.pointerType === 'touch') {
      // Le DOIGT ne dessine jamais : il fait défiler.
      if (drawing) return;            // palm rejection : un tracé stylet est en cours
      if (panId !== null) return;     // un doigt gère déjà le défilement (multi-doigts ignorés)
      if (!scroller) return;
      panId = e.pointerId; panning = true; panMoved = false;
      panStartY = e.clientY; panStartX = e.clientX;
      panTop = scroller.scrollTop; panLeft = scroller.scrollLeft;
      panLastT = nowMs(e); panLastX = e.clientX; panLastY = e.clientY;
      panVX = panVY = 0;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      return;
    }

    // Stylet / souris : prend la main sur le dessin. Si un doigt/une paume avait
    // commencé un défilement, on l'abandonne pour ne pas le confondre avec le tracé.
    if (panning) { try { canvas.releasePointerCapture(panId); } catch {} panning = false; panId = null; }
    penId = e.pointerId;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const p = localPt(e);
    if (tool === 'erase') { eraseAt(p); penId = null; return; }
    drawing = true; startPt = p; points = [p]; previewRect = null;
    if (onDrawingChange) onDrawingChange(true); // verrouille le scroll pendant le tracé (palm rejection)
    redraw();
  }

  function onMove(e) {
    // Défilement au doigt : SEUL le doigt qui a initié le pan.
    if (panning && e.pointerId === panId) {
      const t = nowMs(e), dt = t - panLastT;
      if (dt > 0) {
        // vitesse instantanée lissée (passe-bas) pour une inertie stable
        const ivx = (e.clientX - panLastX) / dt;
        const ivy = (e.clientY - panLastY) / dt;
        const a = 0.7;
        panVX = a * ivx + (1 - a) * panVX;
        panVY = a * ivy + (1 - a) * panVY;
        panLastT = t; panLastX = e.clientX; panLastY = e.clientY;
      }
      const dx = e.clientX - panStartX, dy = e.clientY - panStartY;
      if (!panMoved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) panMoved = true;
      if (scroller) { scroller.scrollTop = panTop - dy; scroller.scrollLeft = panLeft - dx; }
      return;
    }
    // Tracé : SEUL le pointeur stylet qui dessine.
    if (!drawing || e.pointerId !== penId) return;
    e.preventDefault();
    const tool = getTool();
    const p = localPt(e);
    if (tool === 'rect') previewRect = rectFrom(startPt, p);
    else if (tool === 'lasso' || tool === 'highlight') points.push(p);
    redraw();
  }

  function onUp(e) {
    if (panning && e.pointerId === panId) {
      panning = false; panId = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      // Tap du doigt (sans glisser) en mode gomme = effacer LA censure touchée (pas toutes).
      if (!panMoved && getTool() === 'erase') { eraseAt(localPt(e)); return; }
      if (panMoved) startMomentum(); // relance l'inertie sur un vrai glissé
      return;
    }
    if (!drawing || e.pointerId !== penId) return;
    drawing = false; penId = null;
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
    previewRect = null; points = [];
    commit();
  }

  function onCancel(e) {
    if (!e || e.pointerId === panId) { panning = false; panId = null; cancelMomentum(); }
    if (!e || e.pointerId === penId) {
      drawing = false; penId = null;
      if (onDrawingChange) onDrawingChange(false);
      previewRect = null; points = [];
    }
    redraw();
  }

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
    isDrawing: () => drawing,   // utile pour différer une mise à jour SW pendant un tracé
    destroy() {
      cancelMomentum();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.remove();
    },
  };
}
