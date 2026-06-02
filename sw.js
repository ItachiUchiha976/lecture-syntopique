/* Service Worker (classique) — cache de l'app shell + runtime cache-first.
 *
 * Stratégie :
 *  - La version vient du paramètre d'URL (sw.js?v=X), source unique = version.js.
 *    Changer la version => nouveau SW => install => purge des anciens caches.
 *  - Precache : un petit noyau "shell" (best-effort, n'échoue pas si un asset manque).
 *  - Navigations + CODE de l'app (HTML, .js, .css, dont version.js / main.js) : NETWORK-FIRST
 *    avec repli sur le cache. -> les mises à jour s'appliquent dès qu'on est en ligne (plus de
 *    blocage sur une vieille version en cache), tout en restant utilisable hors-ligne.
 *  - Bibliothèques lourdes (vendor/), icônes, polices, WASM, images… : CACHE-FIRST (elles ne
 *    changent pas -> chargement instantané et 100% offline).
 *  - Les DONNÉES utilisateur (PDF, annotations) NE passent PAS par ici : IndexedDB/OPFS.
 */
'use strict';

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'syntopique-' + VERSION;

// Noyau minimal à précacher (le reste est mis en cache au runtime).
const PRECACHE = [
  './',
  'index.html',
  'offline.html',
  'manifest.webmanifest',
  'css/reset.css',
  'css/app.css',
  'css/reader.css',
  'css/toolbar.css',
  'icons/icon-192.png',
  'icons/apple-touch-icon-180.png',
  'js/main.js',
  'vendor/pdfjs/pdf.min.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Ajout individuel : un asset manquant ne fait pas échouer toute l'installation.
    await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tout est vendorisé : pas de cross-origin attendu

  // 1) Navigations (SPA) : NETWORK-FIRST → on sert l'app shell le plus à jour,
  //    repli sur le cache (index.html) puis offline.html si pas de réseau.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const net = await fetch(req);
        cache.put('index.html', net.clone()); // garde l'app shell à jour
        return net;
      } catch {
        return (await cache.match('index.html')) || (await cache.match('offline.html')) || new Response('Hors-ligne', { status: 503 });
      }
    })());
    return;
  }

  // 2) Code de l'app (JS/CSS hors vendor, dont version.js et main.js) : NETWORK-FIRST.
  //    Indispensable pour que les mises à jour de version se propagent (plus de blocage cache).
  const isAppCode = (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) && !url.pathname.includes('/vendor/');
  if (isAppCode) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const net = await fetch(req);
        if (net && net.status === 200 && net.type === 'basic') cache.put(req, net.clone());
        return net;
      } catch {
        return (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  // 3) Reste (vendor/, icônes, polices, WASM, images, manifest…) : CACHE-FIRST.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const net = await fetch(req);
      if (net && net.status === 200 && net.type === 'basic') cache.put(req, net.clone());
      return net;
    } catch (err) {
      const fallback = await cache.match(req, { ignoreSearch: true });
      if (fallback) return fallback;
      throw err;
    }
  })());
});
