// Sauvegarde / restauration du projet complet (livres + annotations + progression
// + réglages), dans un seul fichier JSON. Filet de sécurité contre l'éviction du
// stockage ou un effacement des données Safari.
import * as store from './storage.js';

function bytesToB64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function buildBackup(onProgress) {
  const books = await store.getAllBooks();
  const out = { format: 'syntopique-backup', version: 2, exportedAt: Date.now(), settings: await store.getAllSettings(), books: [] };
  let done = 0;
  for (const b of books) {
    const pages = await store.getPagesByBook(b.id);
    const progress = await store.getProgress(b.id);
    const bin = await store.loadBinary(b.binaryRef);
    const thumb = b.thumbnailRef ? await store.loadBinary(b.thumbnailRef) : null;
    // Notes vocales : on inclut l'audio en base64 (audioRef n'est pas portable d'un appareil à l'autre).
    const notes = await store.getVoiceNotesByBook(b.id);
    const voiceNotes = [];
    for (const n of notes) {
      const audio = n.audioRef ? await store.loadBinary(n.audioRef) : null;
      const { audioRef, ...meta } = n;
      voiceNotes.push({ ...meta, audioB64: audio ? bytesToB64(audio) : null });
    }
    out.books.push({
      meta: b, pages, progress: progress || null,
      pdfB64: bin ? bytesToB64(bin) : null,
      thumbB64: thumb ? bytesToB64(thumb) : null,
      voiceNotes,
    });
    done++; if (onProgress) onProgress(done, books.length);
  }
  return JSON.stringify(out);
}

export async function restoreBackup(text, onProgress) {
  const data = JSON.parse(text);
  if (!data || data.format !== 'syntopique-backup') throw new Error('Fichier de sauvegarde non reconnu.');
  let done = 0, ok = 0;
  const total = (data.books || []).length;
  for (const entry of data.books || []) {
    // Chaque livre est isolé : si l'un échoue, on n'interrompt PAS toute la restauration.
    try {
      const b = entry.meta;
      if (entry.pdfB64) b.binaryRef = await store.saveBinary(`${b.id}/original.pdf`, b64ToBytes(entry.pdfB64), 'application/pdf');
      b.thumbnailRef = entry.thumbB64 ? await store.saveBinary(`${b.id}/thumb.jpg`, b64ToBytes(entry.thumbB64), 'image/jpeg') : null;
      await store.addBook(b);
      for (const p of entry.pages || []) await store.putPage(p);
      if (entry.progress) await store.putProgress(entry.progress);
      // Notes vocales (backup version 2). Absentes des sauvegardes v1 → boucle vide, sans erreur.
      for (const n of entry.voiceNotes || []) {
        const { audioB64, ...meta } = n;
        const ext = meta.ext || 'm4a';
        const mime = meta.mime || 'audio/mp4';
        const audioRef = audioB64 ? await store.saveBinary(`${b.id}/voice/${meta.noteId}.${ext}`, b64ToBytes(audioB64), mime) : null;
        await store.saveVoiceNote({ ...meta, bookId: b.id, audioRef });
      }
      ok++;
    } catch (e) { console.warn('[restore] livre ignoré (erreur)', e); }
    done++; if (onProgress) onProgress(done, total);
  }
  if (data.settings) for (const k of Object.keys(data.settings)) { try { await store.setSetting(k, data.settings[k]); } catch {} }
  return ok;
}

export async function saveBlob(bytesOrString, filename, mime) {
  const blob = new Blob([bytesOrString], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch {}
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// Partage plusieurs fichiers d'un coup (feuille de partage iOS). Repli : téléchargements successifs.
// `files` = tableau d'objets File. Retourne true si le partage natif a été utilisé.
export async function shareFiles(files, title) {
  if (!files || !files.length) return false;
  try {
    if (navigator.share && navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title });
      return true;
    }
  } catch {}
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  return false;
}
