// Utilitaires partagés (sans dépendance).

export function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  // Repli simple
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function debounce(fn, ms) {
  let t = 0;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Throttle "trailing" : exécute au plus une fois toutes les `ms`, dernier appel garanti.
export function throttle(fn, ms) {
  let last = 0, pending = null, timer = 0;
  const run = (args) => { last = performance.now(); pending = null; fn(...args); };
  return function (...args) {
    const now = performance.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) { clearTimeout(timer); run(args); }
    else { pending = args; clearTimeout(timer); timer = setTimeout(() => pending && run(pending), remaining); }
  };
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDate(ms) {
  try { return new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

// Crée un élément DOM rapidement. `attrs` peut contenir : class, text, html, dataset, on{Event}, style…
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Met en forme la progression de lecture en FR pour l'indicateur (mode simple ET double).
// Ex : « 62 % lu · ~18 min · 23 p. restantes » ; quand le livre est lu : « Lecture terminée · prêt à exporter ».
export function formatReadingProgress({ fraction = 0, bookRead = false, remainingMs = 0, pagesRemaining = 0 } = {}) {
  const pct = Math.round(clamp(fraction, 0, 1) * 100);
  if (bookRead) return { label: pct + ' % lu', title: 'Lecture terminée · prêt à exporter' };
  const parts = [pct + ' % lu'];
  const min = Math.round(remainingMs / 60000);
  if (remainingMs > 0) {
    if (min < 1) parts.push('~1 min');
    else if (min < 60) parts.push('~' + min + ' min');
    else parts.push('~' + Math.floor(min / 60) + ' h ' + (min % 60) + ' min');
  }
  if (pagesRemaining > 0) parts.push(pagesRemaining + ' p. restante' + (pagesRemaining > 1 ? 's' : ''));
  const label = parts.join(' · ');
  return { label, title: 'Progression de lecture réelle — ' + label };
}
