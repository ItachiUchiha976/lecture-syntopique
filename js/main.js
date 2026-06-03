// Point d'entrée de l'app.
import { APP_VERSION } from '../version.js';
import { register, startRouter, navigate } from './router.js';
import { requestPersistence, getSetting, setSetting } from './storage.js';
import { toast } from './ui/dialogs.js';
import { showWelcomeTips, showExitQuote, showPostureReminder } from './ui/welcome-tips.js';

// ----- Service worker (offline + install) -----
function registerSW() {
  const swc = ('serviceWorker' in navigator) ? navigator.serviceWorker : null;
  if (!swc) return; // SW indisponible (navigation privée, contexte bloqué…)
  // La version dans l'URL = source unique de vérité (cf. version.js / sw.js).
  swc.register(`sw.js?v=${APP_VERSION}`).then((reg) => {
    // Si un nouveau SW prend le contrôle (nouvelle version), on recharge une fois.
    let refreshing = false, updatePending = false;
    swc.addEventListener('controllerchange', () => {
      // `updatePending` reste faux au tout 1er chargement (clients.claim) → pas de reload parasite.
      if (!updatePending || refreshing) return;
      refreshing = true;
      // Ne pas couper l'utilisateur (censure / enregistrement en cours) : on recharge la nouvelle
      // version uniquement quand l'app est en ARRIÈRE-PLAN ; sinon on attend qu'elle le devienne.
      if (document.visibilityState === 'hidden') { location.reload(); return; }
      const onHide = () => {
        if (document.visibilityState === 'hidden') { document.removeEventListener('visibilitychange', onHide); location.reload(); }
      };
      document.addEventListener('visibilitychange', onHide);
    });
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          updatePending = true;           // c'est une VRAIE mise à jour (un SW contrôlait déjà la page)
          sw.postMessage('SKIP_WAITING'); // active la nouvelle version
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

// Pré-chargement hors-ligne (one-shot) : exerce les bibliothèques chargées PARESSEUSEMENT (OCR,
// export, worker PDF) pendant qu'on est EN LIGNE, pour qu'elles soient mises en cache par le service
// worker. Sans ça, la 1ʳᵉ utilisation de l'OCR/export EN HORS-LIGNE échouerait (vendor non encore caché).
async function warmOfflineCache() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return; // pas de SW actif → on retentera
  try { if (await getSetting('offlineWarmDone')) return; } catch {}
  const base = new URL('./', location.href).href;
  const files = [
    // Modules d'app chargés paresseusement (réseau-d'abord → mis en cache à ce fetch) : lecteur,
    // export, notes vocales… pour qu'ils marchent hors-ligne même sans avoir été ouverts en ligne.
    'js/ui/reader-view.js', 'js/ui/reader-pane.js', 'js/ui/dual-view.js', 'js/ui/search-view.js',
    'js/ui/export-flow.js', 'js/export.js', 'js/ui/voice-notes.js', 'js/voice-recorder.js',
    // Bibliothèques tierces vendorisées (lourdes, chargées à la demande) :
    'vendor/pdf-lib/pdf-lib.min.js',
    'vendor/pdfjs/pdf.worker.min.mjs',
    'vendor/tesseract/tesseract.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/lang/eng.traineddata.gz',
    'vendor/tesseract/lang/fra.traineddata.gz',
    // Cœurs LSTM les plus probables sur iPad/Safari (si Safari en choisit un autre, le 1ᵉʳ OCR en ligne le cachera).
    'vendor/tesseract/tesseract-core-relaxedsimd-lstm.js',
    'vendor/tesseract/tesseract-core-relaxedsimd-lstm.wasm',
    'vendor/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js',
    'vendor/tesseract/tesseract-core-simd-lstm.js',
    'vendor/tesseract/tesseract-core-simd-lstm.wasm',
    'vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  ];
  let allOk = true;
  for (const f of files) {
    try { const r = await fetch(new URL(f, base)); if (!r || !r.ok) allOk = false; }
    catch { allOk = false; }
  }
  if (allOk) { try { await setSetting('offlineWarmDone', true); } catch {} } // sinon on retentera au prochain lancement
}

// Échap ferme la carte d'accueil / l'aide-mémoire / la pause posture / la citation (en plus du tap).
function bindEscapeForOverlays() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const ov = document.querySelector('.welcome-overlay, .usage-overlay, .posture-overlay, .exit-overlay');
    if (!ov) return;
    // Cibler EXPLICITEMENT le bouton de fermeture (et NON un `.btn` nu : sur l'accueil, le 1ᵉʳ .btn en
    // ordre document est le lien « Activer le rappel » → Échap l'aurait déclenché au lieu de fermer).
    const btn = ov.querySelector('.welcome-foot .btn') || ov.querySelector('.exit-dismiss') || ov.querySelector('.dialog__actions .btn');
    if (btn) { e.preventDefault(); btn.click(); }
  });
}

async function boot() {
  registerSW();
  setupRoutes();
  // Persistance du stockage (non bloquant) : protège les données de l'éviction.
  requestPersistence().then((granted) => {
    if (!granted) console.info('[storage] persistance non accordée (sera retentée).');
  });
  await startRouter('library');
  // Reprise des OCR interrompus (l'utilisateur avait fait « Retour à la bibliothèque » puis fermé
  // l'app) : relance en arrière-plan les livres restés en attente, et résorbe l'indicateur « OCR… »
  // resté affiché alors qu'aucun worker ne tournait. Non bloquant, import paresseux de Tesseract.
  import('./ocr.js').then((m) => m.ocrAllPending()).catch((e) => console.warn('[ocr] resume', e));
  bindEscapeForOverlays();
  // Pré-charge les bibliothèques lourdes pour un vrai hors-ligne (différé, en arrière-plan, une seule fois).
  setTimeout(() => { warmOfflineCache().catch((e) => console.warn('[offline] warm', e)); }, 5000);
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
