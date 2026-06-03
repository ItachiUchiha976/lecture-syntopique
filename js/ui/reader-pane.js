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
  let pendingHL = null; // { pageIndex, normQuery, occ } — surlignage de recherche en cours (persistant)
  let scrollLock = null; // {top,left} figés pendant un tracé au stylet (palm rejection)
  let tool = 'none';    // outil de censure actif
  const MIN_ZOOM = 0.35, MAX_ZOOM = 3; // 0.35 → permet de réduire pour voir la page entière
  let zoom = 1;         // facteur de zoom utilisateur (1 = page ajustée à la largeur)
  let baseW = 800;      // largeur "ajustée à la largeur" du conteneur, avant zoom
  const censoredPages = new Set(); // pages marquées "entièrement censurées"

  function computeBaseW() {
    // clientWidth inclut le padding (box-sizing:border-box). On retire le padding RÉEL
    // (résolu par getComputedStyle : env()/max() déjà convertis en px) au lieu d'un -24 codé en
    // dur, sinon la page DÉBORDE de sa colonne et son bord droit tombe sous la zone de gestes
    // système d'iPad (bord physique) → non censurable en lecture double (bug bord droit).
    const w = scroller.clientWidth || element.clientWidth || 800;
    let pad = 24;
    try {
      const cs = getComputedStyle(scroller);
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      if (pl + pr > 0) pad = pl + pr;
    } catch {}
    return clamp(Math.floor(w - pad), 200, 2400);
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

      // Échelle/dimensions d'affichage (px CSS par unité PDF) fixées DÈS le rendu du canvas, HORS de
      // tout try qui pourrait lever : indispensables pour positionner correctement le calque de
      // surlignage OCR (pages scannées). Sans cela, un échec de la couche texte les laisserait nuls
      // → rectangles mal échelonnés.
      entry.dispScale = plan.cssW / nativeSizes[i].w;
      entry.cssW = plan.cssW; entry.cssH = plan.cssH;

      // Enregistrement de la page (texte OCR + censure) lu UNE seule fois et réutilisé plus bas.
      let rec = null;
      try { rec = await store.getPage(book.id, i); } catch {}
      if (entry.cancelled) return;
      entry.ocrWords = (rec && rec.ocrWords) || null; // mots OCR (positions) pour surligner sur un scan

      // Couche de texte sélectionnable (échelle d'AFFICHAGE)
      try {
        const dispVp = page.getViewport({ scale: entry.dispScale });
        const tlDiv = el('div', { class: 'text-layer' });
        tlDiv.style.width = plan.cssW + 'px';
        tlDiv.style.height = plan.cssH + 'px';
        wrap.appendChild(tlDiv);
        const tl = await buildTextLayer(page, dispVp, tlDiv);
        if (entry.cancelled) { tlDiv.remove(); }
        else entry.textLayer = { div: tlDiv, items: tl.textContentItemsStr || [], divs: tl.textDivs || [] };
      } catch (e) { /* couche texte non bloquante */ }

      // Surlignage de recherche en attente : UN SEUL appel, maintenant que la couche texte ET les
      // mots OCR sont connus → couvre le cas natif (<span>) comme le cas scanné (calque de rectangles).
      if (!entry.cancelled && pendingHL && pendingHL.pageIndex === i) applyHighlight(i);

      // Couche de censure (au-dessus de la couche texte)
      try {
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
    if (entry.ocrHlLayer) { entry.ocrHlLayer.remove(); entry.ocrHlLayer = null; }
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
    // Suivi de la page "active" (la plus proche du centre) — utilisée par le bouton
    // « Censurer la page » et le suivi de lecture (progression).
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
  // Calque de surlignage pour les pages SCANNÉES (pas de couche texte) : rectangles ambre posés
  // aux positions des mots OCR. Créé à la demande, retiré avec la page.
  function ensureOcrHlLayer(i, entry) {
    if (entry.ocrHlLayer) return entry.ocrHlLayer;
    const layer = el('div', { class: 'ocr-hl-layer' });
    if (entry.cssH) { layer.style.width = entry.cssW + 'px'; layer.style.height = entry.cssH + 'px'; }
    wraps[i].appendChild(layer);
    entry.ocrHlLayer = layer;
    return layer;
  }
  function removeOcrHlLayer(entry) {
    if (entry && entry.ocrHlLayer) { entry.ocrHlLayer.remove(); entry.ocrHlLayer = null; }
  }

  function applyHighlight(i) {
    const entry = rendered.get(i);
    if (!entry) return;
    // Nettoie l'ancien surlignage (texte natif + calque OCR scanné).
    if (entry.textLayer) entry.textLayer.divs.forEach((d) => d && d.classList.remove('hl', 'hl--current'));
    removeOcrHlLayer(entry);
    if (!pendingHL || pendingHL.pageIndex !== i || !pendingHL.normQuery) return;

    // Discriminant FIABLE : une page OCRisée (scannée) possède entry.ocrWords ; une page native a
    // sa couche texte. (Un scan peut renvoyer une couche texte vide/parasite via getTextContent, d'où
    // ce choix par présence de mots OCR plutôt que par .items.length.) Le repérage des correspondances
    // est IDENTIQUE dans les deux cas (items joints par UNE espace, comme l'indexeur → multi-mots OK) :
    // page native → on surligne les <span> ; page scannée → rectangles aux positions des mots OCR.
    const useOcr = !!(entry.ocrWords && entry.ocrWords.length);
    const native = !useOcr;
    const rawItems = useOcr ? entry.ocrWords.map((w) => w.t) : (entry.textLayer ? entry.textLayer.items : null);
    if (!rawItems || !rawItems.length) return;
    // Jointure des items avec blancs APLATIS (exactement comme l'indexeur : join(' ')+replace(/\s+/g,' ')+trim),
    // PLUS une table char→index d'item. Indispensable : PDF.js insère des items vides / des espaces (fins de
    // ligne) ; sans aplatissement, `joined` aurait des doubles espaces là où le texte indexé n'en a qu'un →
    // une expression à cheval sur une ligne, TROUVÉE par la recherche, ne serait PAS surlignée, et le nombre
    // d'intervalles divergerait du `count` (désalignant la navigation ↑/↓).
    let joined = '';
    const itemAt = []; // itemAt[c] = index de l'item d'où provient le c-ième caractère de `joined`
    let prevSpace = true;
    for (let k = 0; k < rawItems.length; k++) {
      const s = String(rawItems[k] == null ? '' : rawItems[k]);
      for (let c = 0; c < s.length; c++) {
        if (/\s/.test(s[c])) { if (!prevSpace) { joined += ' '; itemAt.push(k); prevSpace = true; } }
        else { joined += s[c]; itemAt.push(k); prevSpace = false; }
      }
      if (k < rawItems.length - 1 && !prevSpace) { joined += ' '; itemAt.push(k); prevSpace = true; } // séparateur entre items
    }
    while (joined.endsWith(' ')) { joined = joined.slice(0, -1); itemAt.pop(); } // trim final
    const { norm, map } = buildNormIndex(joined);
    const intervals = findMatches(norm, map, pendingHL.normQuery, joined.length);
    if (!intervals.length) return;
    const occ = clamp(pendingHL.occ || 0, 0, intervals.length - 1);

    let scrollTarget = null;
    const layer = native ? null : ensureOcrHlLayer(i, entry);
    const ds = native ? 0 : (entry.dispScale || (entry.cssW && nativeSizes[i] ? entry.cssW / nativeSizes[i].w : 1));
    intervals.forEach((iv, idx) => {
      const ks = new Set(); // index d'items couverts par cet intervalle
      for (let pos = iv.start; pos < iv.end && pos < itemAt.length; pos++) ks.add(itemAt[pos]);
      for (const k of ks) {
        if (native) {
          const d = entry.textLayer.divs[k]; if (!d) continue;
          d.classList.add('hl');
          if (idx === occ) { d.classList.add('hl--current'); if (!scrollTarget) scrollTarget = d; }
        } else {
          const wd = entry.ocrWords[k]; if (!wd || !layer) continue;
          const box = el('div', { class: 'ocr-hl' + (idx === occ ? ' ocr-hl--current' : '') });
          box.style.left = (wd.x * ds) + 'px'; box.style.top = (wd.y * ds) + 'px';
          box.style.width = (wd.w * ds) + 'px'; box.style.height = (wd.h * ds) + 'px';
          layer.appendChild(box);
          if (idx === occ && !scrollTarget) scrollTarget = box;
        }
      }
    });
    // Ne centrer qu'au PREMIER affichage du résultat sélectionné. Le surlignage étant persistant,
    // applyHighlight est rappelé à chaque re-rendu (virtualisation) : sans ce garde, revenir sur la
    // page surlignée en défilant re-déclencherait scrollIntoView et détournerait le défilement.
    if (scrollTarget && pendingHL && !pendingHL.scrolled) {
      pendingHL.scrolled = true;
      scrollTarget.scrollIntoView({ block: 'center' });
    }
  }

  function highlightQuery(pageIndex, normQuery, occ = 0) {
    // Efface un éventuel surlignage précédent (sur une autre page) avant d'en poser un nouveau.
    clearHighlights();
    pendingHL = { pageIndex, normQuery, occ };
    scrollToPageInternal(pageIndex);
    if (rendered.has(pageIndex)) applyHighlight(pageIndex);
    else updateVisible();
    // Surlignage PERSISTANT : il RESTE visible pendant la lecture (même en faisant défiler) pour
    // repérer le mot dans une page dense. Il n'est effacé que volontairement — réouverture de la
    // recherche ou saut de page (cf. clearHighlights() appelé par la vue lecteur).
  }
  function clearHighlights() {
    const p = pendingHL; pendingHL = null;
    if (!p) return;
    const e = rendered.get(p.pageIndex);
    if (!e) return;
    if (e.textLayer) e.textLayer.divs.forEach((d) => d && d.classList.remove('hl', 'hl--current'));
    removeOcrHlLayer(e);
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
