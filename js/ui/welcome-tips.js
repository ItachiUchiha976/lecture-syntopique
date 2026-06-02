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
  const close = () => { overlay.style.transition = 'opacity .15s ease'; overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 150); };

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

// ----- Citation de sortie (pop-up plein écran) -----
// iOS ne fournit pas d'évènement fiable « app fermée » ; on déclenche donc cette citation
// quand l'app passe en arrière-plan (visibilitychange → hidden). Affichée une fois par session.
let _exitShown = false;
export function showExitQuote() {
  if (_exitShown) return;
  if (document.querySelector('.exit-overlay')) return;
  _exitShown = true;
  const overlay = el('div', { class: 'overlay exit-overlay' });
  const close = () => overlay.remove();
  const card = el('div', { class: 'exit-card' }, [
    el('p', { class: 'exit-quote', text: QUOTE }),
    el('p', { class: 'exit-author', text: QUOTE_AUTHOR }),
    el('button', { class: 'btn btn--ghost exit-dismiss', text: 'Fermer', onClick: () => close() }),
  ]);
  overlay.appendChild(card);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}
