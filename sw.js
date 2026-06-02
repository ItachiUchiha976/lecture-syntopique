/* Service Worker (classique) — cache de l'app shell + runtime cache-first.
 *
 * Stratégie :
 *  - La version vient du paramètre d'URL (sw.js?v=X), source unique = version.js.
 *    Changer la version => nouveau SW => install => purge des anciens caches.
 *  - Precache : un petit noyau "shell" (best-effort, n'échoue pas si un asset manque).
 *  - Runtime : cache-first pour toutes les requêtes GET de même origine, ce qui
 *    capture automatiquement le reste (modules JS chargés à la demande, polices
 *    PDF.js, WASM, pdf-lib, Tesseract…) au fil de l'utilisation -> 100% offline ensuite.
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

  // Navigations (SPA) : on sert toujours l'app shell (index.html).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cachedShell = await cache.match('index.html');
      if (cachedShell) return cachedShell;
      try {
        const net = await fetch(req);
        return net;
      } catch {
        return (await cache.match('offline.html')) || new Response('Hors-ligne', { status: 503 });
      }
    })());
    return;
  }

  // Autres GET : cache-first, sinon réseau (et on met en cache la réponse).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const net = await fetch(req);
      // On ne met en cache que les réponses complètes et exploitables.
      if (net && net.status === 200 && net.type === 'basic') {
        cache.put(req, net.clone());
      }
      return net;
    } catch (err) {
      // Dernier recours : tenter une correspondance souple.
      const fallback = await cache.match(req, { ignoreSearch: true });
      if (fallback) return fallback;
      throw err;
    }
  })());
});
