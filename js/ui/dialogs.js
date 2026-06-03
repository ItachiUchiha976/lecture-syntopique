// Dialogues modaux + toasts (sans dépendance).
import { el } from '../utils.js';

const toastRoot = () => document.getElementById('toast-root');

export function toast(message, { type = 'info', duration = 2600 } = {}) {
  const root = toastRoot();
  if (!root) return;
  const t = el('div', { class: 'toast' + (type === 'error' ? ' toast--err' : ''), text: message, role: 'status' });
  root.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .2s ease';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 220);
  }, duration);
  return t;
}

// Construit un overlay + dialogue. `build(close)` doit retourner le contenu et
// peut appeler close(value) pour résoudre la promesse.
function modal(build) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'overlay' });
    let done = false;
    const close = (value) => {
      if (done) return; done = true;
      overlay.style.transition = 'opacity .15s ease';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 150);
      resolve(value);
    };
    const content = build(close);
    overlay.appendChild(content);
    // Clic sur le fond = annulation (résout undefined)
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(undefined); });
    document.body.appendChild(overlay);
    // Focus auto. Pour un CHAMP DE SAISIE, focus SYNCHRONE (dans le geste utilisateur) afin que le clavier
    // iOS s'affiche : un focus différé (setTimeout) ne lève PAS le clavier sur iPad/Safari.
    const field = content.querySelector('input, textarea, select');
    if (field) { try { field.focus({ preventScroll: true }); } catch { try { field.focus(); } catch {} } }
    else { const f = content.querySelector('button, [tabindex]'); if (f) setTimeout(() => f.focus(), 30); }
  });
}

export function confirmDialog({ title, message, okText = 'OK', cancelText = 'Annuler', danger = false } = {}) {
  return modal((close) => {
    const ok = el('button', { class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'), text: okText, onClick: () => close(true) });
    const cancel = el('button', { class: 'btn btn--ghost', text: cancelText, onClick: () => close(false) });
    return el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
      title ? el('h3', { text: title }) : null,
      el('p', { html: String(message || '').replace(/\n/g, '<br>') }),
      el('div', { class: 'dialog__actions' }, [cancel, ok]),
    ]);
  }).then((v) => v === true);
}

export function alertDialog({ title, message, okText = 'OK' } = {}) {
  return modal((close) => {
    const ok = el('button', { class: 'btn btn--primary', text: okText, onClick: () => close(true) });
    return el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' }, [
      title ? el('h3', { text: title }) : null,
      el('p', { html: String(message || '').replace(/\n/g, '<br>') }),
      el('div', { class: 'dialog__actions' }, [ok]),
    ]);
  }).then(() => true);
}

export function promptDialog({ title, message, placeholder = '', value = '', okText = 'Valider', type = 'text' } = {}) {
  return modal((close) => {
    const input = el('input', {
      type, placeholder, value,
      // Clavier numérique pour les saisies de nombre (ex. « aller à la page ») sur iPad.
      inputmode: type === 'number' ? 'numeric' : null,
      style: { width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid var(--line)',
               background: 'var(--bg)', color: 'var(--text)', marginTop: '8px', minHeight: '44px' },
      onKeydown: (e) => { if (e.key === 'Enter') close(input.value); if (e.key === 'Escape') close(null); },
    });
    const ok = el('button', { class: 'btn btn--primary', text: okText, onClick: () => close(input.value) });
    const cancel = el('button', { class: 'btn btn--ghost', text: 'Annuler', onClick: () => close(null) });
    return el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, [
      title ? el('h3', { text: title }) : null,
      message ? el('p', { html: String(message).replace(/\n/g, '<br>') }) : null,
      input,
      el('div', { class: 'dialog__actions' }, [cancel, ok]),
    ]);
  });
}
