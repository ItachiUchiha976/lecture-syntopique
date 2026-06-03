// Détection de lecture RÉELLE (anti-triche).
// Principe : chaque page exige un temps de présence minimal plausible, estimé
// depuis son nombre de mots et une vitesse de lecture (mots/min). Le chrono ne
// tourne que pour la page la plus visible ET quand l'app est au premier plan
// (Page Visibility). Scroller jusqu'à la fin ne suffit donc pas : chaque page
// doit avoir été "présente" assez longtemps. L'export se débloque quand
// (quasi) toutes les pages sont satisfaites.
import { clamp, throttle } from './utils.js';
import { getSetting, getProgress, putProgress, getPagesByBook } from './storage.js';

const MIN_PER_PAGE = 4000;     // plancher (pages quasi vides / images)
const MAX_PER_PAGE = 180000;   // plafond (pages très denses)
const TICK_MS = 1000;
const MAX_DELTA = 5000;        // garde-fou anti deltas absurdes
const READ_RATIO = 0.98;       // tolérance : 98% des pages suffisent (pages blanches…)

export function createReadingTracker({ book, onProgress = null }) {
  const totalPages = book.pageCount;
  let wpm = 220;
  let perPage = {};                 // index -> { requiredMs, accumulatedMs, satisfied }
  let wordCounts = {};
  let pagesSatisfied = 0;
  let bookRead = false;
  let active = -1, activeSince = 0;
  let visible = (typeof document === 'undefined') || document.visibilityState === 'visible';
  let timer = null;

  function requiredFor(i) {
    const wc = wordCounts[i] ?? 0;
    if (wc < 10) return MIN_PER_PAGE;
    return clamp((wc / wpm) * 60000, MIN_PER_PAGE, MAX_PER_PAGE);
  }
  function ensure(i) {
    if (!perPage[i]) perPage[i] = { requiredMs: requiredFor(i), accumulatedMs: 0, satisfied: false };
    else perPage[i].requiredMs = requiredFor(i);
    return perPage[i];
  }
  function recount() {
    pagesSatisfied = 0;
    for (let i = 0; i < totalPages; i++) if (perPage[i] && perPage[i].satisfied) pagesSatisfied++;
    const need = Math.max(1, Math.ceil(totalPages * READ_RATIO));
    bookRead = pagesSatisfied >= need;
  }

  // Progression FRACTIONNAIRE (barre fluide) + estimations restantes.
  // fraction = moyenne, sur toutes les pages, du ratio temps_présent/temps_requis (plafonné à 1).
  // remainingMs = temps restant estimé pour finir les pages non encore satisfaites.
  function computeProgress() {
    let acc = 0, remainingMs = 0;
    for (let i = 0; i < totalPages; i++) {
      const pp = perPage[i];
      if (!pp) { remainingMs += requiredFor(i); continue; }
      const r = pp.requiredMs > 0 ? Math.min(1, pp.accumulatedMs / pp.requiredMs) : 1;
      acc += r;
      if (!pp.satisfied) remainingMs += Math.max(0, pp.requiredMs - pp.accumulatedMs);
    }
    return {
      fraction: totalPages ? acc / totalPages : 0,
      remainingMs,
      pagesRemaining: Math.max(0, totalPages - pagesSatisfied),
    };
  }

  function flush() {
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (active < 0 || !visible) { activeSince = now; return; }
    let delta = now - activeSince;
    activeSince = now;
    if (delta < 0) delta = 0;
    if (delta > MAX_DELTA) delta = MAX_DELTA;
    const pp = ensure(active);
    if (!pp.satisfied) {
      pp.accumulatedMs += delta;
      if (pp.accumulatedMs >= pp.requiredMs) { pp.satisfied = true; pagesSatisfied++; const need = Math.max(1, Math.ceil(totalPages * READ_RATIO)); if (pagesSatisfied >= need) bookRead = true; }
    }
  }

  const persist = () => putProgress({
    bookId: book.id, perPage, pagesSatisfied, totalPages, bookRead,
    lastPageIndex: active, updatedAt: Date.now(),
  }).catch(() => {});
  const persistThrottled = throttle(persist, 2000);

  function emit() {
    if (onProgress) onProgress({ pagesSatisfied, totalPages, bookRead, ...computeProgress() });
  }

  function onVis() {
    if (document.hidden) { flush(); visible = false; }
    else { visible = true; activeSince = (typeof performance !== 'undefined') ? performance.now() : Date.now(); }
  }
  function onPageHide() { flush(); persist(); }

  function start() {
    stop();
    timer = setInterval(() => { flush(); persistThrottled(); emit(); }, TICK_MS);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  async function init() {
    wpm = await getSetting('wpm');
    const prog = await getProgress(book.id);
    if (prog && prog.perPage) { perPage = prog.perPage; bookRead = !!prog.bookRead; }
    const pages = await getPagesByBook(book.id);
    for (const p of pages) wordCounts[p.pageIndex] = p.wordCount || 0;
    for (let i = 0; i < totalPages; i++) ensure(i);
    recount();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    if (active < 0) { active = 0; activeSince = (typeof performance !== 'undefined') ? performance.now() : Date.now(); }
    start();
    emit();
  }

  return {
    init,
    setActivePage(i) {
      if (i === active) return;
      flush();
      active = i;
      activeSince = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    },
    get bookRead() { return bookRead; },
    snapshot() { return { pagesSatisfied, totalPages, bookRead, ...computeProgress() }; },
    destroy() {
      flush(); persist(); stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}
