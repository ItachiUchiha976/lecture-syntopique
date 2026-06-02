// Routeur SPA minimal. Chaque vue est une fonction `render(params)` qui retourne
// { element, destroy? }. Le routeur monte l'élément dans #app et appelle destroy()
// à la sortie (essentiel pour libérer les canvas/PDF.js du lecteur).
const routes = new Map();
let current = null;       // { name, params, view }
const appEl = () => document.getElementById('app');

export function register(name, renderFn) { routes.set(name, renderFn); }

async function show(name, params) {
  const renderFn = routes.get(name);
  if (!renderFn) { console.error('[router] route inconnue:', name); return; }
  // Démonte la vue précédente
  if (current && current.view && typeof current.view.destroy === 'function') {
    try { current.view.destroy(); } catch (e) { console.warn('[router] destroy a échoué', e); }
  }
  const root = appEl();
  root.replaceChildren(); // vide l'ancienne vue
  let view;
  try {
    view = await renderFn(params || {});
  } catch (e) {
    console.error('[router] rendu échoué', e);
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = '<h2>Erreur</h2><p>' + (e && e.message ? e.message : 'Vue indisponible') + '</p>';
    root.appendChild(div);
    current = { name, params, view: null };
    return;
  }
  root.appendChild(view.element);
  current = { name, params, view };
}

export async function navigate(name, params = {}, { replace = false } = {}) {
  const state = { name, params };
  const url = '#' + name;
  if (replace) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
  await show(name, params);
}

export function currentRoute() { return current ? { name: current.name, params: current.params } : null; }

export function startRouter(defaultRoute = 'library') {
  window.addEventListener('popstate', (e) => {
    const s = e.state;
    if (s && s.name) show(s.name, s.params);
    else show(defaultRoute, {});
  });
  const initial = (history.state && history.state.name) ? history.state : { name: defaultRoute, params: {} };
  history.replaceState(initial, '', '#' + initial.name);
  return show(initial.name, initial.params);
}
