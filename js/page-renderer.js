// Rendu d'une page PDF dans un canvas, en respectant les plafonds mémoire d'iOS
// Safari (~384 Mo de mémoire canvas cumulée, 4096 px max par côté).
//
// Idée : on calcule une échelle de rendu adaptée à la largeur d'affichage (CSS),
// bornée par la résolution de l'écran (DPR), une aire max par canvas et une
// dimension max. Cela évite les canvas blancs/échecs de rendu sur iPad.

const DEFAULTS = {
  maxDpr: Math.min(window.devicePixelRatio || 1, 2), // au-delà de 2, gain visuel négligeable / coût mémoire fort
  maxDim: 4096,                                       // limite dure iOS par côté de canvas
  maxArea: 6_000_000,                                 // ~24 Mo/canvas ; avec ~5 pages vivantes => ~120 Mo
};

// nativeW/H : taille de la page en unités PDF. cssW : largeur d'affichage souhaitée (px CSS).
export function computeRenderPlan(nativeW, nativeH, cssW, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const aspect = nativeH / nativeW;
  const cssH = cssW * aspect;

  let scale = (cssW / nativeW) * o.maxDpr;
  let w = cssW * o.maxDpr;
  let h = cssH * o.maxDpr;

  // Bornage par dimension max
  const dimRatio = Math.min(1, o.maxDim / Math.max(w, h));
  // Bornage par aire max
  const areaRatio = Math.min(1, Math.sqrt(o.maxArea / (w * h)));
  const r = Math.min(dimRatio, areaRatio);
  scale *= r;

  const canvasW = Math.max(1, Math.floor(nativeW * scale));
  const canvasH = Math.max(1, Math.floor(nativeH * scale));
  return { scale, canvasW, canvasH, cssW: Math.round(cssW), cssH: Math.round(cssH) };
}

// Rend la page dans un canvas neuf. Retourne { canvas, task } ; `task` permet l'annulation.
export function renderPdfPageToCanvas(pdfPage, plan) {
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.width = plan.canvasW;
  canvas.height = plan.canvasH;
  const ctx = canvas.getContext('2d', { alpha: false });
  const viewport = pdfPage.getViewport({ scale: plan.scale });
  const task = pdfPage.render({ canvasContext: ctx, viewport });
  return { canvas, task };
}

// Libère explicitement la mémoire d'un canvas (crucial sur iPad).
export function freeCanvas(canvas) {
  if (!canvas) return;
  try { canvas.width = 0; canvas.height = 0; } catch {}
}
