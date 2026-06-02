// Vue Bibliothèque : grille des livres importés + flux d'import.
import { el, formatBytes, formatDate, uuid } from '../utils.js';
import { toast, confirmDialog, promptDialog } from './dialogs.js';
import { loadDocument, getDocInfo, renderThumbnail, destroyDoc } from '../pdf-engine.js';
import * as store from '../storage.js';
import { navigate } from '../router.js';
import { indexAllPending } from '../text-indexer.js';
import { buildBackup, restoreBackup, saveBlob } from '../backup.js';

function progressOverlay(title) {
  const bar = el('span');
  const label = el('p', { text: '…' });
  const ov = el('div', { class: 'overlay' }, [
    el('div', { class: 'dialog' }, [el('h3', { text: title }), label,
      el('div', { class: 'progress-line', style: { marginTop: '12px' } }, [bar])]),
  ]);
  document.body.appendChild(ov);
  return {
    set: (d, t) => { bar.style.width = (t ? Math.round((d / t) * 100) : 0) + '%'; label.textContent = `${d} / ${t}`; },
    close: () => ov.remove(),
  };
}

export async function renderLibrary() {
  const objectUrls = [];

  const fileInput = el('input', {
    type: 'file', accept: 'application/pdf,.pdf', multiple: true, class: 'hidden',
    onChange: (e) => handleFiles(e.target.files),
  });
  const restoreInput = el('input', {
    type: 'file', accept: 'application/json,.json', class: 'hidden',
    onChange: async (e) => {
      const f = e.target.files && e.target.files[0];
      restoreInput.value = '';
      if (!f) return;
      const dlg = progressOverlay('Restauration…');
      try {
        const n = await restoreBackup(await f.text(), (d, t) => dlg.set(d, t));
        dlg.close();
        await refresh();
        indexAllPending();
        toast(`${n} livre(s) restauré(s).`);
      } catch (err) { dlg.close(); toast('Échec de la restauration : ' + (err.message || err), { type: 'error', duration: 5000 }); }
    },
  });

  const importBtn = el('button', { class: 'btn btn--primary', html: '＋ Importer un PDF', onClick: () => fileInput.click() });
  const backupBtn = el('button', { class: 'btn btn--ghost', text: '⤓ Sauvegarder', title: 'Sauvegarder tout mon projet dans un fichier',
    onClick: async () => {
      const books = await store.getAllBooks();
      if (!books.length) { toast('Aucun livre à sauvegarder.'); return; }
      const dlg = progressOverlay('Sauvegarde…');
      try {
        const json = await buildBackup((d, t) => dlg.set(d, t));
        dlg.close();
        const date = new Date().toISOString().slice(0, 10);
        await saveBlob(json, `syntopique-backup-${date}.json`, 'application/json');
        toast('Sauvegarde créée.');
      } catch (e) { dlg.close(); toast('Échec de la sauvegarde : ' + (e.message || e), { type: 'error', duration: 5000 }); }
    } });
  const restoreBtn = el('button', { class: 'btn btn--ghost', text: '⤒ Restaurer', title: 'Restaurer depuis un fichier de sauvegarde',
    onClick: () => restoreInput.click() });

  const toolbar = el('div', { class: 'library__toolbar' }, [importBtn, backupBtn, restoreBtn, fileInput, restoreInput]);
  const listHost = el('div');
  const content = el('div', { class: 'library' }, [toolbar, listHost]);

  const header = el('header', { class: 'app-header' }, [
    el('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }),
    el('span', { class: 'title', text: 'Lecture Syntopique' }),
    el('span', { class: 'spacer' }),
  ]);
  const element = el('div', { class: 'view' }, [header, content]);

  function emptyState() {
    return el('div', { class: 'empty-state' }, [
      el('h2', { text: 'Aucun livre pour l’instant' }),
      el('p', { text: 'Importe un ou plusieurs PDF pour commencer. Tes fichiers restent stockés localement sur l’appareil, accessibles hors-ligne.' }),
      el('div', { style: { marginTop: '18px' } }, [
        el('button', { class: 'btn btn--primary', html: '＋ Importer un PDF', onClick: () => fileInput.click() }),
      ]),
    ]);
  }

  async function refresh() {
    objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const books = await store.getAllBooks();
    listHost.replaceChildren();
    if (!books.length) { listHost.appendChild(emptyState()); return; }
    const grid = el('div', { class: 'library__grid' });
    for (const b of books) grid.appendChild(await bookCard(b));
    listHost.appendChild(grid);
  }

  async function bookCard(b) {
    let thumb;
    if (b.thumbnailRef) {
      const blob = await store.loadBinaryBlob(b.thumbnailRef);
      if (blob) { const u = URL.createObjectURL(blob); objectUrls.push(u); thumb = el('img', { src: u, alt: '' }); }
    }
    const badges = el('div', { class: 'book-card__badges' });
    if (b.ocrStatus === 'running' || b.ocrStatus === 'pending')
      badges.appendChild(el('span', { class: 'badge badge--work', text: 'OCR…' }));

    return el('div', { class: 'book-card' }, [
      el('div', { class: 'book-card__thumb', onClick: () => open(b) }, [
        thumb || el('span', { text: 'PDF' }),
        el('button', { class: 'book-card__del', html: '🗑', title: 'Supprimer ce livre',
          onClick: (e) => { e.stopPropagation(); remove(b); } }),
      ]),
      el('div', { class: 'book-card__body' }, [
        el('div', { class: 'book-card__title', text: b.title, title: b.title }),
        el('div', { class: 'book-card__meta', text: `${b.pageCount} page${b.pageCount > 1 ? 's' : ''} · ${formatBytes(b.byteSize)} · ${formatDate(b.importedAt)}` }),
        badges,
      ]),
      el('div', { class: 'book-card__actions' }, [
        el('button', { class: 'btn', text: 'Ouvrir', onClick: () => open(b) }),
        el('button', { class: 'btn', text: 'Comparer', onClick: () => openCompare(b) }),
        el('button', { class: 'btn', text: 'Renommer', onClick: () => rename(b) }),
        el('button', { class: 'btn btn--danger', text: 'Suppr.', onClick: () => remove(b) }),
      ]),
    ]);
  }

  function open(b) { navigate('reader', { bookId: b.id }); }

  async function openCompare(book) {
    const others = (await store.getAllBooks()).filter((b) => b.id !== book.id);
    if (!others.length) { toast('Importe un second livre pour pouvoir comparer.'); return; }
    const overlay = el('div', { class: 'overlay' });
    const close = () => overlay.remove();
    const list = el('div', { class: 'compare-list' }, others.map((b) =>
      el('button', { class: 'btn', text: b.title, onClick: () => { close(); navigate('dual', { leftBookId: book.id, rightBookId: b.id }); } })));
    overlay.appendChild(el('div', { class: 'dialog' }, [
      el('h3', { text: `Comparer « ${book.title} » avec…` }),
      list,
      el('div', { class: 'dialog__actions' }, [el('button', { class: 'btn btn--ghost', text: 'Annuler', onClick: close })]),
    ]));
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  async function rename(b) {
    const name = await promptDialog({ title: 'Renommer', value: b.title, okText: 'Renommer' });
    if (name && name.trim()) { await store.updateBook(b.id, { title: name.trim() }); refresh(); }
  }

  async function remove(b) {
    const ok = await confirmDialog({
      title: 'Supprimer ce livre ?',
      message: `« ${b.title} » et toutes ses annotations seront définitivement supprimés de l’app.`,
      okText: 'Supprimer', danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteBook(b.id);
      toast('Livre supprimé.');
    } catch (e) {
      console.error('[delete]', e);
      toast('Échec de la suppression : ' + (e.message || e), { type: 'error', duration: 5000 });
    }
    refresh();
  }

  // ---------- Import ----------
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    fileInput.value = '';
    if (!files.length) return;

    const bar = el('span');
    const label = el('p', { text: 'Préparation…' });
    const dialog = el('div', { class: 'overlay' }, [
      el('div', { class: 'dialog' }, [
        el('h3', { text: 'Import en cours' }),
        label,
        el('div', { class: 'progress-line', style: { marginTop: '14px' } }, [bar]),
      ]),
    ]);
    document.body.appendChild(dialog);

    let done = 0, ok = 0;
    for (const file of files) {
      label.textContent = `Import de « ${file.name} » (${done + 1}/${files.length})…`;
      bar.style.width = `${Math.round((done / files.length) * 100)}%`;
      try { await importOne(file); ok++; }
      catch (e) {
        console.error('[import]', e);
        toast(`Échec de l’import de ${file.name} : ${e.message || e}`, { type: 'error', duration: 4000 });
      }
      done++;
      bar.style.width = `${Math.round((done / files.length) * 100)}%`;
    }
    dialog.remove();
    await refresh();
    if (ok) toast(`${ok} livre${ok > 1 ? 's' : ''} importé${ok > 1 ? 's' : ''}.`);
    indexAllPending(); // indexation texte en fond (recherche)
  }

  async function importOne(file) {
    const bookId = uuid();
    const bytes = new Uint8Array(await file.arrayBuffer());
    // slice() : PDF.js peut "détacher" le buffer passé en `data` ; on garde `bytes` intact pour le stockage.
    const pdfDoc = await loadDocument(bytes.slice(), {
      onPassword: async (reason) => promptDialog({
        title: 'PDF protégé',
        message: reason === 2 ? 'Mot de passe incorrect. Réessaie :' : 'Ce PDF demande un mot de passe :',
        type: 'password', okText: 'Ouvrir',
      }),
    });
    const info = await getDocInfo(pdfDoc);
    const thumbBlob = await renderThumbnail(pdfDoc).catch(() => null);
    destroyDoc(pdfDoc);

    const binaryRef = await store.saveBinary(`${bookId}/original.pdf`, bytes, 'application/pdf');
    let thumbnailRef = null;
    if (thumbBlob) {
      const tb = new Uint8Array(await thumbBlob.arrayBuffer());
      thumbnailRef = await store.saveBinary(`${bookId}/thumb.jpg`, tb, 'image/jpeg');
    }

    const now = Date.now();
    await store.addBook({
      id: bookId,
      title: info.title || file.name.replace(/\.pdf$/i, ''),
      fileName: file.name,
      byteSize: file.size,
      pageCount: info.numPages,
      firstSize: info.firstSize,
      pageSizes: [],
      binaryRef,
      thumbnailRef,
      importedAt: now,
      lastOpenedAt: now,
      ocrStatus: 'none',
      ocrProgress: 0,
      textSource: 'unknown',
    });
  }

  await refresh();
  indexAllPending(); // indexation texte en fond des livres pas encore indexés
  return {
    element,
    destroy() { objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u)); },
  };
}
