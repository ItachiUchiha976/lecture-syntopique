// Carte d'accueil affichée à CHAQUE ouverture : 2 astuces permanentes (palais de mémoire +
// notes vocales). Le bloc « rappel quotidien » n'apparaît que tant qu'il n'a pas été activé
// (l'app retient juste si TU as cliqué « Activer » — une PWA ne peut pas lire ton Google Agenda),
// avec un bouton « me le rappeler dans 3 mois » et une réapparition avant l'expiration (~3 mois).
// Citation de sortie : pop-up plein écran déclenché quand l'app passe en arrière-plan.
import { el } from '../utils.js';
import { getSetting, setSetting } from '../storage.js';

const QUOTE = '« Si vous ne travaillez pas pour vos rêves, quelqu’un vous embauchera pour travailler pour les siens. »';
const QUOTE_AUTHOR = '— Steve Jobs —';

const DAY = 24 * 3600 * 1000;
const SNOOZE_MS = 90 * DAY;     // « me le rappeler dans 3 mois »
const REPROMPT_MS = 80 * DAY;   // re-proposer juste avant la fin du rappel (~3 mois)

// Lien « modèle » Google Agenda : évènement récurrent quotidien 07h00 sur ~3 mois.
// ctz=Europe/Paris par défaut (ajustable d'un tap dans Google Agenda avant d'enregistrer).
function googleCalendarLink() {
  const base = 'https://calendar.google.com/calendar/render';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Lecture syntopique sur iPad 10',
    dates: '20260603T070000/20260603T071500',
    ctz: 'Europe/Paris',
    recur: 'RRULE:FREQ=DAILY;UNTIL=20260903',
    details: 'Ouvre l’app de Lecture Syntopique : lis et compare tes PDF, enregistre tes connexions vocales, puis mémorise-les dans un palais de mémoire.',
  });
  return `${base}?${params.toString()}`;
}

export async function showWelcomeTips() {
  if (document.querySelector('.welcome-overlay')) return; // déjà affichée
  const now = Date.now();
  let reminderDone = false, doneAt = 0, snoozeUntil = 0;
  try {
    reminderDone = !!(await getSetting('reminderDone'));
    doneAt = (await getSetting('reminderDoneAt')) || 0;
    snoozeUntil = (await getSetting('reminderSnoozeUntil')) || 0;
  } catch {}

  // Faut-il afficher le bloc rappel ?
  let showReminder;
  if (snoozeUntil && now < snoozeUntil) showReminder = false;        // reporté
  else if (!reminderDone) showReminder = true;                       // jamais activé → on propose
  else showReminder = (now - doneAt) >= REPROMPT_MS;                 // activé : re-proposer avant la fin

  const overlay = el('div', { class: 'overlay welcome-overlay' });
  // À la fermeture de cette carte, on enchaîne sur l'aide-mémoire d'utilisation.
  const close = () => {
    overlay.style.transition = 'opacity .15s ease'; overlay.style.opacity = '0';
    setTimeout(() => { overlay.remove(); showUsageGuide(); }, 150);
  };

  const tip1 = el('div', { class: 'welcome-tip' }, [
    el('span', { class: 'welcome-tip__icon', text: '🧠' }),
    el('p', { html: 'Pense à <strong>mémoriser les connexions découvertes dans un palais de mémoire</strong>.' }),
  ]);
  const tip2 = el('div', { class: 'welcome-tip' }, [
    el('span', { class: 'welcome-tip__icon', text: '🎤' }),
    el('p', { html: 'Enregistre tes <strong>connexions vocales</strong> (bouton 🎤) : explique à voix haute les liens que tu découvres, puis partage-les vers une IA (Claude, Gemini…).' }),
  ]);

  const children = [el('h3', { text: '👋 Avant de lire…' }), tip1, tip2];

  if (showReminder) {
    const calBtn = el('a', {
      class: 'btn btn--primary', href: googleCalendarLink(), target: '_blank', rel: 'noopener',
      html: '⏰ Activer le rappel quotidien (7h00)',
      onClick: () => {
        setSetting('reminderDone', true).catch(() => {});
        setSetting('reminderDoneAt', Date.now()).catch(() => {});
        setSetting('reminderSnoozeUntil', 0).catch(() => {});
        reminderBlock.remove();
      },
    });
    const laterBtn = el('button', {
      class: 'btn btn--ghost', text: 'Me le rappeler dans 3 mois',
      onClick: () => { setSetting('reminderSnoozeUntil', Date.now() + SNOOZE_MS).catch(() => {}); reminderBlock.remove(); },
    });
    const icsLink = el('a', {
      class: 'welcome-ics', href: 'rappels/rappel-lecture-syntopique.ics', download: 'rappel-lecture-syntopique.ics',
      text: 'ou télécharger le rappel (.ics)',
    });
    var reminderBlock = el('div', { class: 'welcome-reminder' }, [calBtn, laterBtn, icsLink]);
    children.push(reminderBlock);
  }

  children.push(el('div', { class: 'welcome-foot' }, [
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn btn--ghost', text: 'C’est parti', onClick: () => close() }),
  ]));

  const card = el('div', { class: 'dialog welcome-card', role: 'dialog', 'aria-modal': 'true' }, children);
  overlay.appendChild(card);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// ----- Aide-mémoire d'utilisation (2e carte, après les 2 messages) -----
// Affiché à chaque ouverture, juste après la carte d'accueil : rappel express des
// gestes clés (censurer, ouvrir 2 PDF, censurer toute une page, rétablir).
function showUsageGuide() {
  if (document.querySelector('.usage-overlay')) return;
  const overlay = el('div', { class: 'overlay usage-overlay' });
  const close = () => { overlay.style.transition = 'opacity .15s ease'; overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 150); };
  const item = (icon, title, desc) => el('div', { class: 'usage-item' }, [
    el('span', { class: 'usage-item__icon', text: icon }),
    el('div', {}, [
      el('div', { class: 'usage-item__title', html: title }),
      el('div', { class: 'usage-item__desc', html: desc }),
    ]),
  ]);
  const card = el('div', { class: 'dialog usage-card', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', { text: '📖 Aide-mémoire' }),
    el('div', { class: 'usage-scroll' }, [
      item('🧰', 'Les outils de la barre', '<ul class="usage-tools">' +
        '<li><strong>✋ Lecture</strong> : faire défiler et sélectionner le texte (aucun dessin).</li>' +
        '<li><strong>▭ Rectangle</strong> et <strong>◌ Forme libre</strong> : censure <strong>noire</strong> (cache le texte).</li>' +
        '<li><strong>🖊️ Surligneur</strong> : trait <strong>bleu translucide</strong> (emphase, garde le texte lisible).</li>' +
        '<li><strong>⌫ Gomme</strong> : effacer une censure (tape-la du doigt). <strong>↶ Annuler</strong> : le dernier tracé.</li>' +
        '<li><strong>− / 100 % / +</strong> : zoom. <strong>Censurer la page</strong> : masquer toute la page lue (réversible ; en double : un bouton par livre, G/D).</li>' +
        '<li><strong>🎤</strong> notes vocales · <strong>🔍</strong> recherche · <strong>p.X</strong> aller à une page.</li>' +
        '<li><strong>⇄</strong> changer le livre (en double) · <strong>Exporter</strong> le PDF filtré.</li>' +
        '</ul>'),
      item('🖊️', 'Censurer ou surligner', '<strong>Censurer</strong> (cacher en noir) : ▭ rectangle ou ◌ forme libre. <strong>Surligner</strong> (mettre en avant <em>sans</em> cacher) : 🖊 surligneur <strong>bleu translucide</strong>. Dessine à l’<strong>Apple Pencil</strong> ; le doigt fait défiler.'),
      item('▦', 'Lecture double', 'Bouton <strong>Comparer</strong> → choisis le 2ᵉ PDF. Le bouton <strong>⇄</strong> remplace un des deux. La <strong>recherche 🔍 et l’export</strong> y sont aussi disponibles (sur le panneau actif).'),
      item('✔️', 'Censurer toute une page', 'Bouton <strong>Censurer la page</strong> : masque entièrement la page en cours de lecture (elle sera <strong>supprimée du PDF exporté</strong>). En lecture double, <strong>un bouton par livre</strong> (Censurer G / Censurer D) pour ne pas censurer les deux d’un coup. <strong>Réversible</strong> à tout moment (le bouton devient « Rétablir »).'),
      item('♻️', 'Effacer / rétablir', 'Gomme <strong>⌫</strong> + <strong>tape une censure du doigt</strong> pour retirer celle-là précisément. <strong>↶</strong> annule le dernier tracé. Page entière : <strong>Rétablir</strong>. Réversible même après réouverture du PDF.'),
      item('🎤', 'Connexions vocales', 'Bouton <strong>🎤</strong> → <strong>● Enregistrer</strong>, parle, <strong>■ Stop</strong>. Puis ▶︎ écouter, ⤴ partager (Drive / IA), 🗑 supprimer.'),
      item('🔍', 'Rechercher', 'Insensible à la <strong>casse et aux accents</strong>. <strong>3 portées</strong> : <strong>Ce livre</strong> (le PDF sélectionné), <strong>Les 2 livres</strong> (en lecture double), <strong>Tous les livres</strong> (tous les PDF importés, ouverts ou non). Le mot trouvé est surligné un instant.'),
      item('🔢', 'Aller à une page', 'Touche l’indicateur <strong>p.X</strong> (en haut) pour sauter directement à un numéro de page — en simple <strong>et</strong> double.'),
      item('📊', 'Progression de lecture', 'En haut s’affiche <strong>X % lu · ~temps restant · pages restantes</strong> — basé sur le temps réellement passé sur chaque page (en simple <strong>et</strong> double).'),
      item('📤', 'Exporter', 'Se débloque <strong>quand tu as lu tout le livre</strong>. Les <strong>pages censurées</strong> sont supprimées du PDF, les <strong>ratures gravées</strong> (le texte dessous disparaît vraiment), mais le <strong>reste du texte reste cherchable</strong> (l’OCR est ré-appliqué pour un PDF scanné). Ton livre d’origine reste intact.'),
      item('📍', 'Reprise de lecture', 'À la réouverture d’un livre, tu retrouves <strong>automatiquement la dernière page lue</strong> (chaque panneau en double).'),
    ]),
    el('div', { class: 'welcome-foot' }, [
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn--primary', text: 'Compris', onClick: () => close() }),
    ]),
  ]);
  overlay.appendChild(card);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// ----- Pause posture : recadrage du dos contre le mur (« ange mural » / wall angel) -----
// Déclenché toutes les heures de présence active (cf. main.js) et à la sortie de l'app,
// juste après la citation. Réversible/ignorable d'un tap.
export function showPostureReminder() {
  if (document.querySelector('.posture-overlay')) return;
  const overlay = el('div', { class: 'overlay posture-overlay' });
  const close = () => { overlay.style.transition = 'opacity .15s ease'; overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 150); };
  const card = el('div', { class: 'dialog posture-card', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', { text: '🧍 Pause posture — recadre ton dos' }),
    el('p', { class: 'posture-intro', text: 'Tu lis depuis un moment : 30 secondes pour réaligner ton dos contre un mur.' }),
    el('ol', { class: 'posture-steps' }, [
      el('li', { html: 'Tiens-toi <strong>debout, dos contre un mur</strong>.' }),
      el('li', { html: 'Colle au mur : l’<strong>arrière de la tête</strong>, le <strong>haut du dos (omoplates)</strong> et les <strong>fesses</strong> (talons légèrement décollés si besoin).' }),
      el('li', { html: '<strong>Rentre doucement le menton</strong> (léger double menton) pour aligner la nuque.' }),
      el('li', { html: 'Garde la courbe naturelle du bas du dos, respire, et <strong>tiens 20–30 s</strong>.' }),
    ]),
    el('p', { class: 'posture-note', html: '<em>Variante « ange mural » : bras contre le mur, coudes pliés, fais-les glisser de haut en bas (comme un ange dans la neige) — ça ouvre les épaules.</em>' }),
    el('div', { class: 'welcome-foot' }, [
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn btn--primary', text: 'C’est fait 👍', onClick: () => close() }),
    ]),
  ]);
  overlay.appendChild(card);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// ----- Citation de sortie (pop-up plein écran) -----
// iOS ne fournit pas d'évènement fiable « app fermée » ; on déclenche donc cette citation
// quand l'app passe en arrière-plan (visibilitychange → hidden). Affichée une fois par session.
let _exitShown = false;
export function showExitQuote() {
  if (_exitShown) return;
  if (document.querySelector('.exit-overlay')) return;
  _exitShown = true;
  const overlay = el('div', { class: 'overlay exit-overlay' });
  // Après la citation : on enchaîne sur la pause posture (recadrage du dos).
  const close = () => { overlay.remove(); showPostureReminder(); };
  const card = el('div', { class: 'exit-card' }, [
    el('p', { class: 'exit-quote', text: QUOTE }),
    el('p', { class: 'exit-author', text: QUOTE_AUTHOR }),
    el('button', { class: 'btn btn--ghost exit-dismiss', text: 'Fermer', onClick: () => close() }),
  ]);
  overlay.appendChild(card);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}
