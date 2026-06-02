// Notes vocales de connexion : enregistre à voix haute les liens découverts entre les
// documents, puis relis / partage l'audio (Drive, Claude, Gemini…) ou supprime-le.
// Audio stocké via storage.saveBinary (OPFS/IndexedDB) ; partage via la feuille iOS.
import { el, uuid, formatDate, formatDuration } from '../utils.js';
import { toast, confirmDialog } from './dialogs.js';
import * as store from '../storage.js';
import { startRecording, isRecordingSupported } from '../voice-recorder.js';
import { saveBlob, shareFiles } from '../backup.js';

function pad(n) { return String(n).padStart(2, '0'); }
function clock(ms) { const s = Math.floor(ms / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }

function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40); }

function buildTitle(ctx) {
  const c = ctx.context || {};
  if (c.mode === 'dual' && c.left && c.right) {
    const lp = c.left.pageIndex >= 0 ? ` p.${c.left.pageIndex + 1}` : '';
    const rp = c.right.pageIndex >= 0 ? ` p.${c.right.pageIndex + 1}` : '';
    return `${c.left.title}${lp} ↔ ${c.right.title}${rp}`;
  }
  const p = ctx.pageIndex >= 0 ? ` — p.${ctx.pageIndex + 1}` : '';
  return `${ctx.title || 'Connexion'}${p}`;
}

// getContext() → { bookId, pageIndex, title, context } (résolu au moment de l'enregistrement).
export function createVoiceNotes({ getContext }) {
  const objectUrls = [];
  let controller = null;     // contrôleur d'enregistrement en cours (ou null)
  let timerId = 0;
  let startedAt = 0;

  // ---- Bouton dans la barre d'outils ----
  const button = el('button', { class: 'btn voice-toggle', html: '🎤', title: 'Connexions vocales (notes audio)',
    onClick: () => toggle() });

  // ---- Panneau ----
  const timeLabel = el('span', { class: 'voice-rec__time', text: '00:00' });
  const recBtn = el('button', { class: 'btn voice-rec', html: '● Enregistrer',
    title: 'Enregistrer une connexion vocale', onClick: () => onRecord() });
  const hint = el('p', { class: 'voice-hint', text: 'Explique à voix haute le lien que tu découvres. L’audio (.m4a) reste sur l’appareil ; tu peux le partager vers Drive ou une IA.' });
  const listHost = el('div', { class: 'voice-list' });
  const exportAllBtn = el('button', { class: 'btn btn--ghost voice-export-all', html: '⤓ Tout exporter',
    title: 'Partager toutes les connexions vocales de ce livre', onClick: () => exportAll() });
  const closeBtn = el('button', { class: 'btn btn-icon', html: '✕', title: 'Fermer', onClick: () => close() });

  const panel = el('div', { class: 'voice-panel hidden' }, [
    el('div', { class: 'voice-panel__head' }, [
      el('strong', { text: '🎙️ Connexions vocales' }),
      el('span', { class: 'spacer' }),
      closeBtn,
    ]),
    el('div', { class: 'voice-rec__row' }, [recBtn, timeLabel]),
    hint,
    listHost,
    el('div', { class: 'voice-panel__foot' }, [exportAllBtn]),
  ]);

  function isOpen() { return !panel.classList.contains('hidden'); }
  function open() { panel.classList.remove('hidden'); button.setAttribute('aria-pressed', 'true'); refresh(); }
  function close() { panel.classList.add('hidden'); button.setAttribute('aria-pressed', 'false'); }
  function toggle() { isOpen() ? close() : open(); }

  // ---- Enregistrement ----
  function tick() { timeLabel.textContent = clock(performance.now() - startedAt); }
  function setRecordingUI(on) {
    recBtn.classList.toggle('voice-rec--on', on);
    recBtn.innerHTML = on ? '■ Stop' : '● Enregistrer';
    if (on) { startedAt = performance.now(); timeLabel.textContent = '00:00'; timerId = setInterval(tick, 250); }
    else { clearInterval(timerId); timerId = 0; }
  }

  async function onRecord() {
    if (controller) { await stopAndSave(); return; }
    if (!isRecordingSupported()) { toast('Micro non disponible sur ce navigateur.', { type: 'error' }); return; }
    try { controller = await startRecording(); }
    catch (e) { toast(e.message || 'Micro indisponible.', { type: 'error', duration: 4500 }); return; }
    setRecordingUI(true);
  }

  async function stopAndSave() {
    const c = controller; controller = null;
    setRecordingUI(false);
    let result;
    try { result = await c.stop(); }
    catch (e) { console.warn('[voice]', e); toast('Échec de l’enregistrement.', { type: 'error' }); return; }
    if (!result || !result.blob || result.durationMs < 500) { toast('Note trop courte, ignorée.'); return; }
    const ctx = getContext();
    if (!ctx || !ctx.bookId) { toast('Contexte introuvable.'); return; }
    const noteId = uuid();
    const ext = result.ext || 'm4a';
    const mime = result.mime || 'audio/mp4';
    try {
      const u8 = new Uint8Array(await result.blob.arrayBuffer());
      const audioRef = await store.saveBinary(`${ctx.bookId}/voice/${noteId}.${ext}`, u8, mime);
      await store.saveVoiceNote({
        bookId: ctx.bookId, noteId, createdAt: Date.now(), durationMs: result.durationMs,
        ext, mime, audioRef, pageIndex: ctx.pageIndex, context: ctx.context || null, title: buildTitle(ctx),
      });
      toast('Connexion vocale enregistrée.');
      await refresh();
    } catch (e) { console.warn('[voice]', e); toast('Impossible d’enregistrer la note.', { type: 'error' }); }
  }

  // ---- Liste ----
  function currentBookId() { const ctx = getContext(); return ctx && ctx.bookId; }

  async function refresh() {
    const bookId = currentBookId();
    listHost.replaceChildren();
    objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    if (!bookId) return;
    const notes = await store.getVoiceNotesByBook(bookId);
    exportAllBtn.style.display = notes.length ? '' : 'none';
    if (!notes.length) {
      listHost.appendChild(el('p', { class: 'voice-empty', text: 'Aucune connexion vocale pour ce livre. Appuie sur ● pour en enregistrer une.' }));
      return;
    }
    for (const n of notes.slice().reverse()) listHost.appendChild(noteRow(n, bookId));
  }

  function noteRow(n, bookId) {
    const meta = el('div', { class: 'voice-note__meta' }, [
      el('div', { class: 'voice-note__title', text: n.title || 'Connexion', title: n.title || '' }),
      el('div', { class: 'voice-note__sub', text: `${formatDate(n.createdAt)} · ${formatDuration(n.durationMs || 0)}` }),
    ]);
    const playBtn = el('button', { class: 'btn btn-icon', html: '▶︎', title: 'Écouter', onClick: () => playInline(row, n) });
    const shareBtn = el('button', { class: 'btn btn-icon', html: '⤴', title: 'Partager (Drive, IA…)', onClick: () => shareOne(n) });
    const delBtn = el('button', { class: 'btn btn-icon btn--danger', html: '🗑', title: 'Supprimer', onClick: () => removeOne(n, bookId) });
    const row = el('div', { class: 'voice-note' }, [
      meta,
      el('div', { class: 'voice-note__actions' }, [playBtn, shareBtn, delBtn]),
    ]);
    return row;
  }

  async function playInline(row, n) {
    if (row.querySelector('audio')) return; // déjà ouvert
    const blob = await store.loadBinaryBlob(n.audioRef);
    if (!blob) { toast('Audio introuvable.'); return; }
    const url = URL.createObjectURL(blob); objectUrls.push(url);
    const audio = el('audio', { controls: '', src: url, autoplay: '', style: { width: '100%', marginTop: '8px' } });
    row.appendChild(audio);
  }

  function fileName(n) { return `connexion-${safeName(n.title)}-${formatDate(n.createdAt)}.${n.ext || 'm4a'}`; }

  async function shareOne(n) {
    const blob = await store.loadBinaryBlob(n.audioRef);
    if (!blob) { toast('Audio introuvable.'); return; }
    await saveBlob(blob, fileName(n), n.mime || 'audio/mp4');
  }

  async function exportAll() {
    const bookId = currentBookId(); if (!bookId) return;
    const notes = await store.getVoiceNotesByBook(bookId);
    if (!notes.length) { toast('Aucune note à exporter.'); return; }
    const files = [];
    for (const n of notes) {
      const blob = await store.loadBinaryBlob(n.audioRef);
      if (blob) files.push(new File([blob], fileName(n), { type: n.mime || 'audio/mp4' }));
    }
    if (!files.length) { toast('Aucun audio disponible.'); return; }
    await shareFiles(files, 'Connexions vocales');
  }

  async function removeOne(n, bookId) {
    const ok = await confirmDialog({ title: 'Supprimer cette note ?',
      message: 'La note vocale sera définitivement supprimée.', okText: 'Supprimer', danger: true });
    if (!ok) return;
    await store.deleteVoiceNote(bookId, n.noteId);
    toast('Note supprimée.');
    await refresh();
  }

  return {
    button,
    panel,
    refresh,
    isOpen,
    destroy() {
      try { if (controller) controller.cancel(); } catch {}
      clearInterval(timerId);
      objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
