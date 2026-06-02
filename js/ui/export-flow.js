// Assistant d'export du PDF filtré : avertissement -> récap -> choix gravure -> génération.
import { el } from '../utils.js';
import { toast, confirmDialog, alertDialog } from './dialogs.js';
import { exportFilteredPdf } from '../export.js';
import * as store from '../storage.js';

function sanitize(name) { return String(name || 'livre').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'livre'; }

// Modale de choix : gravure (irréversible) vs léger (intact).
function chooseBurn() {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'overlay' });
    const close = (v) => { overlay.remove(); resolve(v); };
    const burnBtn = el('button', { class: 'btn btn--primary', text: 'Graver les censures (recommandé)',
      onClick: () => close('burn') });
    const lightBtn = el('button', { class: 'btn', text: 'Garder les pages intactes',
      onClick: () => close('light') });
    const cancel = el('button', { class: 'btn btn--ghost', text: 'Annuler', onClick: () => close(null) });
    overlay.appendChild(el('div', { class: 'dialog', role: 'dialog' }, [
      el('h3', { text: 'Que faire des censures sur les pages conservées ?' }),
      el('p', { html:
        '<b>Graver (irréversible)</b> : les zones masquées sont définitivement noircies (la page devient une image, le texte caché disparaît vraiment).<br><br>' +
        '<b>Garder intactes</b> : on superpose de simples rectangles noirs ; le texte sous le masque resterait techniquement récupérable.' }),
      el('div', { class: 'dialog__actions', style: { flexWrap: 'wrap' } }, [cancel, lightBtn, burnBtn]),
    ]));
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);
  });
}

function progressDialog(title) {
  const bar = el('span');
  const label = el('p', { text: 'Préparation…' });
  const overlay = el('div', { class: 'overlay' }, [
    el('div', { class: 'dialog' }, [
      el('h3', { text: title }),
      label,
      el('div', { class: 'progress-line', style: { marginTop: '14px' } }, [bar]),
    ]),
  ]);
  document.body.appendChild(overlay);
  return {
    set(done, total) {
      const p = total ? Math.round((done / total) * 100) : 0;
      bar.style.width = p + '%';
      label.textContent = `Page ${done} / ${total}…`;
    },
    close() { overlay.remove(); },
  };
}

async function saveOrShare(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  try {
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) { /* annulé ou non supporté -> repli téléchargement */ }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

export async function runExportFlow({ book }) {
  const pages = await store.getPagesByBook(book.id);
  const censored = pages.filter((p) => p.censored).length;
  const kept = book.pageCount - censored;

  if (kept <= 0) {
    await alertDialog({ title: 'Export impossible',
      message: 'Toutes les pages sont marquées comme censurées : le PDF résultant serait vide. Rétablis au moins une page avant d’exporter.' });
    return;
  }

  const ok = await confirmDialog({
    title: 'Avant d’exporter — réfléchis bien',
    message: `As-tu bien identifié les informations précieuses à garder, et celles à supprimer ?\n\n` +
      `• ${censored} page(s) censurée(s) seront DÉFINITIVEMENT supprimées du PDF exporté.\n` +
      `• ${kept} page(s) seront conservées.\n\n` +
      `Ton livre d’origine reste intact dans l’app : seul un nouveau PDF est créé.`,
    okText: 'Continuer', cancelText: 'Annuler',
  });
  if (!ok) return;

  const choice = await chooseBurn();
  if (!choice) return;

  const prog = progressDialog('Génération du PDF filtré…');
  try {
    const bytes = await exportFilteredPdf(book, { burnPartial: choice === 'burn', onProgress: (d, t) => prog.set(d, t) });
    prog.close();
    await saveOrShare(bytes, `${sanitize(book.title)} (filtré).pdf`);
    toast('PDF filtré généré.');
  } catch (e) {
    prog.close();
    console.error('[export]', e);
    await alertDialog({ title: 'Échec de l’export', message: String((e && e.message) || e) });
  }
}
