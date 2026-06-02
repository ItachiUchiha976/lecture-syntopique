// Carte d'accueil affichée à chaque ouverture de l'app : 2 rappels/astuces + un bouton
// pour créer le rappel quotidien (Google Agenda ou fichier .ics). Masquable via une case.
import { el } from '../utils.js';
import { getSetting, setSetting } from '../storage.js';

// Lien « modèle » Google Agenda : crée un évènement récurrent quotidien à 07h00 sur ~6 mois.
// ctz=Europe/Paris par défaut (ajustable d'un tap dans Google Agenda avant d'enregistrer).
function googleCalendarLink() {
  const base = 'https://calendar.google.com/calendar/render';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Lecture syntopique sur iPad 10',
    dates: '20260603T070000/20260603T071500',
    ctz: 'Europe/Paris',
    recur: 'RRULE:FREQ=DAILY;UNTIL=20261203',
    details: 'Ouvre l’app de Lecture Syntopique : lis et compare tes PDF, enregistre tes connexions vocales, puis mémorise-les dans un palais de mémoire.',
  });
  return `${base}?${params.toString()}`;
}

export async function showWelcomeTips() {
  let hidden = false;
  try { hidden = await getSetting('hideTips'); } catch {}
  if (hidden) return;
  if (document.querySelector('.welcome-overlay')) return; // déjà affichée

  const overlay = el('div', { class: 'overlay welcome-overlay' });
  const close = () => { overlay.style.transition = 'opacity .15s ease'; overlay.style.opacity = '0'; setTimeout(() => overlay.remove(), 150); };

  const tip1 = el('div', { class: 'welcome-tip' }, [
    el('span', { class: 'welcome-tip__icon', text: '🧠' }),
    el('p', { html: 'Pense à <strong>mémoriser les connexions découvertes dans un palais de mémoire</strong>.' }),
  ]);
  const tip2 = el('div', { class: 'welcome-tip' }, [
    el('span', { class: 'welcome-tip__icon', text: '🤖' }),
    el('p', { html: 'Astuce : tu peux <strong>fusionner des PDF via une IA</strong>, puis lire cette fusion à côté d’une source originale — tu compares ainsi l’avis de l’IA avec celui de l’auteur.' }),
  ]);

  const calBtn = el('a', { class: 'btn btn--primary', href: googleCalendarLink(), target: '_blank', rel: 'noopener',
    html: '⏰ Activer le rappel quotidien (7h00)' });
  const icsLink = el('a', { class: 'welcome-ics', href: 'rappels/rappel-lecture-syntopique.ics', download: 'rappel-lecture-syntopique.ics',
    text: 'ou télécharger le rappel (.ics)' });

  const dontShow = el('input', { type: 'checkbox', id: 'welcome-hide' });
  dontShow.addEventListener('change', () => { setSetting('hideTips', dontShow.checked).catch(() => {}); });
  const dontShowRow = el('label', { class: 'welcome-hide', for: 'welcome-hide' }, [dontShow, el('span', { text: ' Ne plus afficher ces messages' })]);

  const okBtn = el('button', { class: 'btn btn--ghost', text: 'C’est parti', onClick: () => close() });

  const card = el('div', { class: 'dialog welcome-card', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', { text: '👋 Avant de lire…' }),
    tip1,
    tip2,
    el('div', { class: 'welcome-reminder' }, [calBtn, icsLink]),
    el('div', { class: 'welcome-foot' }, [dontShowRow, el('span', { class: 'spacer' }), okBtn]),
  ]);

  overlay.appendChild(card);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}
