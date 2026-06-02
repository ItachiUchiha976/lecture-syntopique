// Composant lecteur réutilisable (mode simple ET double).
// Scroll vertical + virtualisation (mémoire), couche de texte sélectionnable,
// et API de surlignage de recherche. La couche de censure s'ajoute en Phase 4.
import { el, clamp, debounce } from '../utils.js';
import { computeRenderPlan, renderPdfPageToCanvas, freeCanvas } from '../page-renderer.js';
import { buildTextLayer } from '../pdf-engine.js';
import { buildNormIndex, findMatches } from '../text-normalize.js';
import { createCensorLayer } from '../censor.js';
import * as store from '../storage.js';

export function createReaderPane({ book, pdfDoc, dual = false, onActivePage = null, onMarksChange = null, onCensoredChange = null, onZoom = null }) {
  const numPages = book.pageCount;
  const scroller = el('div', { class: 'pages-scroller', style: { position: 'relative' }, dataset: { tool: 'none' } });
  const element = el('div', { class: 'reader' }, [scroller]);

  const nativeSizes = new Array(numPages).fill(null);
  if (book.firstSize) nativeSizes[0] = book.firstSize;
  if (Array.isArray(book.pageSizes)) book.pageSizes.forEach((s, i) => { if (s) nativeSizes[i] = s; });

  const wraps = new Array(numPages);
  const rendered = new Map(); // index -> { canvas, task, cancelled, textLayer }
  let queue = [];
  let processing = false;
  let cssW = 800;
  let rafPending = false;
  let pendingHL = null; // { pageIndex, normQuery, occ }
  let scrollLock = null; // {top,left} figés pendant un tracé au stylet (palm rejection)
  let tool = 'none';    // outil de censure actif
  const MIN_ZOOM = 0.5, MAX_ZOOM = 3;
  let zoom = 1;         // facteur de zoom utilisateur (1 = page ajustée à la largeur)
  let baseW = 800;      // largeur "ajustée à la largeur" du conteneur, avant zoom
  const censoredPages = new Set(); // pages marquées "entièrement censurées"

  function computeBaseW() {
    const w = scroller.clientWidth || element.clientWidth || 800;
    return clamp(Math.floor(w - 24), 200, 2400);
  }
  // Largeur d'affichage effective = largeur ajustée au conteneur × zoom utilisateur.
  function recomputeWidths() {
    baseW = computeBaseW();
    cssW = clamp(Math.round(baseW * zoom), 120, 3200);
  }
  function aspectOf(i) {
    const s = nativeSizes[i] || book.firstSize || { w: 1, h: 1.414 };
    return s.h / s.w;
  }
  function setWrapSize(i) {
    const wrap = wraps[i];
    if (!wrap) return;
    wrap.style.width = cssW + 'px';
    wrap.style.height = Math.round(cssW * aspectOf(i)) + 'px';
  }
  function makePlaceholder(i) {
    return el('div', { class: 'page-placeholder' }, [el('span', { text: `Page ${i + 1}` })]);
  }

  for (let i = 0; i < numPages; i++) {
    const wrap = el('div', { class: 'page-wrap', dataset: { index: String(i) } }, [
      el('span', { class: 'page-number', text: String(i + 1) }),
      makePlaceholder(i),
    ]);
    wraps[i] = wrap;
    scroller.appendChild(wrap);
  }

  // ---- File de rendu (sérialisée, priorité au plus proche du centre) ----
  function enqueue(i) { if (!queue.includes(i)) queue.push(i); processQueue(); }
  async function processQueue() {
    if (processing) return;
    processing = true;
    while (queue.length) {
      queue.sort((a, b) => distToView(a) - distToView(b));
      const i = queue.shift();
      if (rendered.has(i) || !isWanted(i)) continue;
      await renderPage(i);
    }
    processing = false;
  }

  async function renderPage(i) {
    const wrap = wraps[i];
    const entry = { canvas: null, task: null, cancelled: false, textLayer: null };
    rendered.set(i, entry);
    let page = null;
    try {
      page = await pdfDoc.getPage(i + 1);
      if (entry.cancelled) return;
      if (!nativeSizes[i]) {
        const vp1 = page.getViewport({ scale: 1 });
        nativeSizes[i] = { w: vp1.width, h: vp1.height };
        setWrapSize(i);
      }
      // En zoom, on autorise une aire de canvas plus grande (rendu plus net),
      // bornée (× zoom, plafonné à 2×) pour rester sous les plafonds mémoire iPad.
      const zoomArea = Math.min(2, Math.max(1, zoom));
      const maxArea = (dual ? 3_000_000 : 6_000_000) * zoomArea;
      const plan = computeRenderPlan(nativeSizes[i].w, nativeSizes[i].h, cssW, { maxArea });
      const { canvas, task } = renderPdfPageToCanvas(page, plan);
      entry.canvas = canvas; entry.task = task;
      await task.promise;
      if (entry.cancelled) { freeCanvas(canvas); return; }
      wrap.querySelector('.page-placeholder')?.remove();
      wrap.appendChild(canvas);

      // Couche de texte sélectionnable (échelle d'AFFICHAGE)
      try {
        const dispScale = plan.cssW / nativeSizes[i].w;
        const dispVp = page.getViewport({ scale: dispScale });
        const tlDiv = el('div', { class: 'text-layer' });
        tlDiv.style.width = plan.cssW + 'px';
        tlDiv.style.height = plan.cssH + 'px';
        wrap.appendChild(tlDiv);
        const tl = await buildTextLayer(page, dispVp, tlDiv);
        if (entry.cancelled) { tlDiv.remove(); }
        else {
          entry.textLayer = { div: tlDiv, items: tl.textContentItemsStr || [], divs: tl.textDivs || [] };
          if (pendingHL && pendingHL.pageIndex === i) applyHighlight(i);
        }
      } catch (e) { /* couche texte non bloquante */ }

      // Couche de censure (au-dessus de la couche texte)
      try {
        let rec = null;
        try { rec = await store.getPage(book.id, i); } catch {}
        const initialMarks = (rec && rec.censorMarks) || [];
        if (rec && rec.censored) censoredPages.add(i);
        if (!entry.cancelled) {
          entry.censor = createCensorLayer({
            wrap, cssW: plan.cssW, cssH: plan.cssH,
            nativeW: nativeSizes[i].w, nativeH: nativeSizes[i].h,
            getTextDivs: () => (entry.textLayer ? entry.textLayer.divs : []),
            getTool: () => tool,
            onDrawingChange: setDrawingLock,
            initialMarks,
            onCommit: (marks) => {
              store.patchPage(book.id, i, { censorMarks: marks }).catch(() => {});
              if (onMarksChange) onMarksChange(i, marks);
            },
          });
          if (censoredPages.has(i)) addCensoredOverlay(i, entry);
        }
      } catch (e) { console.warn('[censor] init', e); }
    } catch (err) {
      if (!err || err.name !== 'RenderingCancelledException') console.warn('[reader] page', i + 1, err);
      if (entry.canvas) freeCanvas(entry.canvas);
    } finally {
      if (page) page.cleanup();
      if (entry.cancelled) rendered.delete(i);
    }
  }

  function recycle(i) {
    const entry = rendered.get(i);
    queue = queue.filter((x) => x !== i);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.task && entry.task.cancel) { try { entry.task.cancel(); } catch {} }
    if (entry.canvas) { entry.canvas.remove(); freeCanvas(entry.canvas); }
    if (entry.textLayer && entry.textLayer.div) entry.textLayer.div.remove();
    if (entry.censor) { try { entry.censor.destroy(); } catch {} }
    if (entry.overlay) { entry.overlay.remove(); entry.overlay = null; }
    rendered.delete(i);
    const wrap = wraps[i];
    if (!wrap.querySelector('.page-placeholder')) wrap.appendChild(makePlaceholder(i));
  }

  // ---- Virtualisation par position de scroll ----
  const MARGIN_FACTOR = 1.2;
  function viewBounds() {
    const top = scroller.scrollTop;
    const vh = scroller.clientHeight || 600;
    const m = vh * MARGIN_FACTOR;
    return { top: top - m, bottom: top + vh + m, center: top + vh / 2 };
  }
  function isWanted(i) {
    const b = viewBounds();
    const t = wraps[i].offsetTop, h = wraps[i].offsetHeight;
    return (t + h > b.top) && (t < b.bottom);
  }
  function distToView(i) {
    const b = viewBounds();
    const c = wraps[i].offsetTop + wraps[i].offsetHeight / 2;
    return Math.abs(c - b.center);
  }

  let lastActive = -1;
  function updateVisible() {
    for (let i = 0; i < numPages; i++) {
      if (isWanted(i)) { if (!rendered.has(i) && !queue.includes(i)) enqueue(i); }
      else if (rendered.has(i) || queue.includes(i)) recycle(i);
    }
    // Suivi de la page "active" (la plus proche du centre) — utile pour "Vérifier"
    // (Phase 5) et le suivi de lecture (Phase 6).
    let best = -1, bd = Infinity;
    const b = viewBounds();
    for (let i = 0; i < numPages; i++) {
      const c = wraps[i].offsetTop + wraps[i].offsetHeight / 2;
      const d = Math.abs(c - b.center);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && best !== lastActive) { lastActive = best; if (onActivePage) onActivePage(best); }
  }

  const onScroll = () => {
    // Pendant un tracé au stylet, on fige la position : la paume posée (touch) ne
    // peut pas faire défiler la page sous le dessin (palm rejection).
    if (scrollLock) { scroller.scrollTop = scrollLock.top; scroller.scrollLeft = scrollLock.left; return; }
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; updateVisible(); });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  // Verrou de défilement pendant un tracé au stylet (palm rejection).
  function setDrawingLock(active) {
    scrollLock = active ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null;
  }

  const onResize = debounce(() => {
    recomputeWidths();
    for (let i = 0; i < numPages; i++) setWrapSize(i);
    for (const i of [...rendered.keys()]) recycle(i);
    updateVisible();
  }, 200);
  window.addEventListener('resize', onResize);

  function layout() {
    recomputeWidths();
    for (let i = 0; i < numPages; i++) setWrapSize(i);
    updateVisible();
  }
  requestAnimationFrame(() => { layout(); if (!scroller.clientWidth) setTimeout(layout, 80); });

  // ---- Zoom utilisateur (boutons − / 100% / +) ----
  function applyZoom() {
    // Conserve la position de lecture (même fraction du document) après re-rendu.
    const ratio = scroller.scrollTop / (scroller.scrollHeight || 1);
    recomputeWidths();
    for (let i = 0; i < numPages; i++) setWrapSize(i);
    for (const i of [...rendered.keys()]) recycle(i);
    scroller.scrollTop = ratio * (scroller.scrollHeight || 1);
    updateVisible();
    if (onZoom) onZoom(zoom);
  }
  function setZoom(z) {
    const nz = clamp(Number(z) || 1, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nz - zoom) > 0.001) { zoom = nz; applyZoom(); }
    return zoom;
  }
  function zoomBy(factor) { return setZoom(zoom * factor); }
  function resetZoom() { return setZoom(1); }

  function scrollToPageInternal(i, smooth = false) {
    if (wraps[i]) scroller.scrollTo({ top: Math.max(0, wraps[i].offsetTop - 8), behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---- Surlignage de recherche ----
  function applyHighlight(i) {
    const entry = rendered.get(i);
    if (!entry || !entry.textLayer) return;
    const { items, divs } = entry.textLayer;
    divs.forEach((d) => d && d.classList.remove('hl', 'hl--current'));
    if (!pendingHL || pendingHL.pageIndex !== i || !pendingHL.normQuery) return;
    const joined = items.join('');
    const { norm, map } = buildNormIndex(joined);
    const intervals = findMatches(norm, map, pendingHL.normQuery, joined.length);
    if (!intervals.length) return;
    const offs = []; let acc = 0;
    for (const s of items) { offs.push(acc); acc += s.length; }
    const occ = clamp(pendingHL.occ || 0, 0, intervals.length - 1);
    let currentDiv = null;
    intervals.forEach((iv, idx) => {
      for (let k = 0; k < items.length; k++) {
        const s = offs[k], e = offs[k] + items[k].length;
        if (e > iv.start && s < iv.end) {
          const d = divs[k]; if (!d) continue;
          d.classList.add('hl');
          if (idx === occ) { d.classList.add('hl--current'); if (!currentDiv) currentDiv = d; }
        }
      }
    });
    if (currentDiv) currentDiv.scrollIntoView({ block: 'center' });
  }

  function highlightQuery(pageIndex, normQuery, occ = 0) {
    pendingHL = { pageIndex, normQuery, occ };
    scrollToPageInternal(pageIndex);
    if (rendered.has(pageIndex) && rendered.get(pageIndex).textLayer) applyHighlight(pageIndex);
    else updateVisible();
  }
  function clearHighlights() {
    const p = pendingHL; pendingHL = null;
    if (p) { const e = rendered.get(p.pageIndex); if (e && e.textLayer) e.textLayer.divs.forEach((d) => d && d.classList.remove('hl', 'hl--current')); }
  }

  // ---- Page entièrement censurée (réversible) ----
  function addCensoredOverlay(i, entry) {
    if (entry.overlay) return;
    const ov = el('div', { class: 'censored-overlay' }, [
      el('div', { class: 'label', text: 'Page censurée' }),
      el('button', { class: 'btn btn--ghost', text: 'Rétablir',
        onClick: (e) => { e.stopPropagation(); setPageCensored(i, false); } }),
    ]);
    wraps[i].appendChild(ov);
    entry.overlay = ov;
  }
  function setPageCensored(i, val) {
    if (val) censoredPages.add(i); else censoredPages.delete(i);
    store.patchPage(book.id, i, { censored: !!val }).catch(() => {});
    const e = rendered.get(i);
    if (e) { if (val) addCensoredOverlay(i, e); else if (e.overlay) { e.overlay.remove(); e.overlay = null; } }
    if (onCensoredChange) onCensoredChange(i, !!val);
  }

  return {
    element,
    scroller,
    layout,
    get activePage() { return lastActive; },
    scrollToPage: (i, smooth) => scrollToPageInternal(i, smooth),
    highlightQuery,
    clearHighlights,
    getWrap: (i) => wraps[i],
    getNativeSize: (i) => nativeSizes[i],
    // ---- Zoom ----
    setZoom, zoomBy, resetZoom, getZoom: () => zoom,
    // ---- Censure ----
    setTool(t) { tool = t || 'none'; scroller.dataset.tool = tool; },
    getTool: () => tool,
    undoActivePage() { const e = rendered.get(lastActive); return (e && e.censor) ? e.censor.undo() : false; },
    getActivePageIndex: () => lastActive,
    getCensorMarks(i) { const e = rendered.get(i); return (e && e.censor) ? e.censor.getMarks() : null; },
    setCensorMarks(i, marks) {
      const e = rendered.get(i);
      if (e && e.censor) e.censor.setMarks(marks);
      store.patchPage(book.id, i, { censorMarks: marks }).catch(() => {});
    },
    setPageCensored,
    isPageCensored: (i) => censoredPages.has(i),
    destroy() {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      for (const i of [...rendered.keys()]) recycle(i);
      queue = [];
    },
  };
}
