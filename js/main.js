// Point d'entrée de l'app.
import { APP_VERSION } from '../version.js';
import { register, startRouter, navigate } from './router.js';
import { requestPersistence } from './storage.js';
import { toast } from './ui/dialogs.js';
import { showWelcomeTips, showExitQuote, showPostureReminder } from './ui/welcome-tips.js';

// ----- Service worker (offline + install) -----
function registerSW() {
  const swc = ('serviceWorker' in navigator) ? navigator.serviceWorker : null;
  if (!swc) return; // SW indisponible (navigation privée, contexte bloqué…)
  // La version dans l'URL = source unique de vérité (cf. version.js / sw.js).
  swc.register(`sw.js?v=${APP_VERSION}`).then((reg) => {
    // Si un nouveau SW prend le contrôle (nouvelle version), on recharge une fois.
    let refreshing = false;
    swc.addEventListener('controllerchange', () => {
      if (refreshing) return; refreshing = true; location.reload();
    });
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          sw.postMessage('SKIP_WAITING'); // active immédiatement la nouvelle version
        }
      });
    });
    // iPad/Safari : vérifie proactivement une nouvelle version quand l'app revient au
    // premier plan (adopte la mise à jour sans rechargement manuel).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('[sw] enregistrement échoué', e));
}

// ----- Routes -----
function setupRoutes() {
  register('library', async () => (await import('./ui/library-view.js')).renderLibrary());
  register('reader', async (params) => (await import('./ui/reader-view.js')).renderReader(params));
  register('dual', async (params) => (await import('./ui/dual-view.js')).renderDual(params));
}

async function boot() {
  registerSW();
  setupRoutes();
  // Persistance du stockage (non bloquant) : protège les données de l'éviction.
  requestPersistence().then((granted) => {
    if (!granted) console.info('[storage] persistance non accordée (sera retentée).');
  });
  await startRouter('library');
  // Messages d'accueil (2 astuces + rappel quotidien), à chaque ouverture. Non bloquant.
  showWelcomeTips().catch((e) => console.warn('[tips]', e));
  // Citation de sortie : quand l'app passe en arrière-plan (≈ quand on la quitte sur iPad).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') showExitQuote();
  });

  // Pause posture : toutes les heures de présence ACTIVE (au-delà d'1h passée dans l'app ouverte).
  let activeMin = 0, lastHourShown = 0;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return; // on ne compte que le temps app ouverte au 1er plan
    activeMin += 1;
    const hours = Math.floor(activeMin / 60);
    if (hours >= 1 && hours > lastHourShown) { lastHourShown = hours; showPostureReminder(); }
  }, 60000);
}

boot().catch((e) => {
  console.error('Échec du démarrage', e);
  toast('Erreur de démarrage : ' + (e.message || e), { type: 'error', duration: 5000 });
});
