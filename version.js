// Source unique de vérité pour la version de l'app.
// À INCRÉMENTER à chaque déploiement : cela change l'URL d'enregistrement du
// service worker (sw.js?v=...) et donc le nom du cache, ce qui force la mise à
// jour propre de l'app sur l'iPad (purge de l'ancien cache).
export const APP_VERSION = '2026.06.03.10';
