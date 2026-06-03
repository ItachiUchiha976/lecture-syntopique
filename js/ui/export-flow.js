// Assistant d'export du PDF filtré : avertissement -> récap -> choix gravure -> génération.
import { el } from '../utils.js';
import { toast, confirmDialog, alertDialog } from './dialogs.js';
import { exportFilteredPdf } from '../export.js';
import * as store from '../storage.js';

function sanitize(name) { return String(name || 'livre').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'livre'; }

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
      `• ${kept} page(s) seront conservées.\n` +
      `• Les zones masquées (rectangle / forme libre) sont GRAVÉES : le texte dessous disparaît vraiment.\n` +
      `• Le reste du texte reste CHERCHABLE (pour un livre scanné, l’OCR est ré-appliqué : cela peut prendre quelques minutes).\n\n` +
      `Ton livre d’origine reste intact dans l’app : seul un nouveau PDF est créé.`,
    okText: 'Exporter', cancelText: 'Annuler',
  });
  if (!ok) return;

  const prog = progressDialog('Génération du PDF filtré…');
  try {
    const bytes = await exportFilteredPdf(book, { onProgress: (d, t) => prog.set(d, t) });
    prog.close();
    await saveOrShare(bytes, `${sanitize(book.title)} (filtré).pdf`);
    toast('PDF filtré généré.');
  } catch (e) {
    prog.close();
    console.error('[export]', e);
    await alertDialog({ title: 'Échec de l’export', message: String((e && e.message) || e) });
  }
}
