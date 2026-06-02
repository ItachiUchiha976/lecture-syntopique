// Façade de persistance : métadonnées/annotations en IndexedDB, binaires PDF en
// OPFS (avec repli automatique IndexedDB-Blob). Le reste de l'app ignore où
// vivent réellement les octets.
import { getDB, STORES } from './db-schema.js';

// ---------- Persistance du stockage (anti-éviction 7 jours) ----------
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const granted = already || await navigator.storage.persist();
      await setSetting('persistGranted', !!granted);
      return !!granted;
    }
  } catch (e) { console.warn('[storage] persist() a échoué', e); }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch {}
  return { usage: 0, quota: 0 };
}

// ---------- OPFS (avec détection robuste + repli) ----------
let _opfsState = 'unknown'; // 'unknown' | 'ok' | 'unavailable'

async function opfsRoot() {
  if (!(navigator.storage && navigator.storage.getDirectory)) throw new Error('OPFS absent');
  return navigator.storage.getDirectory();
}

async function opfsFileHandle(key, { create }) {
  const parts = key.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = await opfsRoot();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(fileName, { create });
}

async function opfsWrite(key, bytes) {
  const fh = await opfsFileHandle(key, { create: true });
  // createWritable n'est pas garanti sur toutes les versions d'iOS Safari.
  if (typeof fh.createWritable !== 'function') throw new Error('createWritable absent');
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

async function opfsRead(key) {
  const fh = await opfsFileHandle(key, { create: false });
  const file = await fh.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function opfsRemoveBook(bookId) {
  try {
    const root = await opfsRoot();
    await root.removeEntry(bookId, { recursive: true });
  } catch {}
}

// Supprime UN fichier OPFS d'après sa clé (`a/b/c.ext`). Utilisé pour effacer une seule
// note vocale sans toucher au reste du dossier du livre.
async function opfsRemoveFile(key) {
  try {
    const parts = key.split('/').filter(Boolean);
    const fileName = parts.pop();
    let dir = await opfsRoot();
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: false });
    await dir.removeEntry(fileName);
  } catch {}
}

// ---------- Binaires (PDF, vignettes) ----------
// Retourne une référence { kind:'opfs'|'idb', key }.
export async function saveBinary(key, bytes, mime = 'application/octet-stream') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (_opfsState !== 'unavailable') {
    try {
      await opfsWrite(key, u8);
      _opfsState = 'ok';
      return { kind: 'opfs', key };
    } catch (e) {
      _opfsState = 'unavailable';
      console.warn('[storage] OPFS indisponible, repli IndexedDB.', e);
    }
  }
  const db = await getDB();
  await db.put(STORES.blobs, { key, blob: new Blob([u8], { type: mime }) });
  return { kind: 'idb', key };
}

export async function loadBinary(ref) {
  if (!ref) return null;
  if (ref.kind === 'opfs') return opfsRead(ref.key);
  const db = await getDB();
  const rec = await db.get(STORES.blobs, ref.key);
  if (!rec) return null;
  return new Uint8Array(await rec.blob.arrayBuffer());
}

export async function loadBinaryBlob(ref) {
  if (!ref) return null;
  if (ref.kind === 'idb') {
    const db = await getDB();
    const rec = await db.get(STORES.blobs, ref.key);
    return rec ? rec.blob : null;
  }
  const u8 = await loadBinary(ref);
  return u8 ? new Blob([u8]) : null;
}

async function deleteBinary(ref) {
  if (!ref) return;
  if (ref.kind === 'idb') {
    const db = await getDB();
    await db.delete(STORES.blobs, ref.key);
  } else if (ref.kind === 'opfs') {
    await opfsRemoveFile(ref.key);
  }
}

// ---------- Books ----------
export async function addBook(book) {
  const db = await getDB();
  await db.put(STORES.books, book);
  return book;
}
export async function getBook(id) { return (await getDB()).get(STORES.books, id); }
export async function updateBook(id, patch) {
  const db = await getDB();
  const b = await db.get(STORES.books, id);
  if (!b) return null;
  const merged = { ...b, ...patch };
  await db.put(STORES.books, merged);
  return merged;
}
export async function getAllBooks() {
  const db = await getDB();
  const all = await db.getAll(STORES.books);
  return all.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
}
export async function deleteBook(id) {
  const db = await getDB();
  const book = await db.get(STORES.books, id);
  // Pages
  const tx = db.transaction(STORES.pages, 'readwrite');
  const idx = tx.store.index('byBook');
  for await (const cursor of idx.iterate(IDBKeyRange.only(id))) cursor.delete();
  await tx.done;
  // Notes vocales (métadonnées) de ce livre ; leurs audios partent avec le préfixe bookId/ ci-dessous.
  const notesTx = db.transaction(STORES.voiceNotes, 'readwrite');
  const notesIdx = notesTx.store.index('byBook');
  for await (const cursor of notesIdx.iterate(IDBKeyRange.only(id))) cursor.delete();
  await notesTx.done;
  // Progression + binaires
  await db.delete(STORES.readingProgress, id);
  if (book) {
    if (book.binaryRef) await deleteBinary(book.binaryRef);
    if (book.thumbnailRef) await deleteBinary(book.thumbnailRef);
  }
  // Blobs IDB éventuels rattachés à ce livre (préfixe bookId/)
  const blobsTx = db.transaction(STORES.blobs, 'readwrite');
  for await (const cursor of blobsTx.store.iterate()) {
    if (typeof cursor.key === 'string' && cursor.key.startsWith(id + '/')) cursor.delete();
  }
  await blobsTx.done;
  await opfsRemoveBook(id);
  await db.delete(STORES.books, id);
}

// ---------- Pages ----------
export async function putPage(page) { return (await getDB()).put(STORES.pages, page); }
export async function getPage(bookId, pageIndex) { return (await getDB()).get(STORES.pages, [bookId, pageIndex]); }
export async function getPagesByBook(bookId) {
  const db = await getDB();
  return db.getAllFromIndex(STORES.pages, 'byBook', IDBKeyRange.only(bookId));
}
// Met à jour une page existante ou en crée une "vide" si absente.
export async function patchPage(bookId, pageIndex, patch) {
  const db = await getDB();
  const cur = (await db.get(STORES.pages, [bookId, pageIndex])) || { bookId, pageIndex };
  const merged = { ...cur, ...patch };
  await db.put(STORES.pages, merged);
  return merged;
}

// ---------- Reading progress ----------
export async function getProgress(bookId) { return (await getDB()).get(STORES.readingProgress, bookId); }
export async function putProgress(progress) { return (await getDB()).put(STORES.readingProgress, progress); }

// ---------- Notes vocales de connexion ----------
// La méta vit dans le store `voiceNotes` ; l'audio binaire est rangé via saveBinary()
// (OPFS `${bookId}/voice/${noteId}.<ext>` ou repli IndexedDB) et référencé par `audioRef`.
export async function saveVoiceNote(note) { return (await getDB()).put(STORES.voiceNotes, note); }
export async function getVoiceNote(bookId, noteId) { return (await getDB()).get(STORES.voiceNotes, [bookId, noteId]); }
export async function getVoiceNotesByBook(bookId) {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORES.voiceNotes, 'byBook', IDBKeyRange.only(bookId));
  return all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
export async function deleteVoiceNote(bookId, noteId) {
  const db = await getDB();
  const note = await db.get(STORES.voiceNotes, [bookId, noteId]);
  if (note && note.audioRef) await deleteBinary(note.audioRef);
  await db.delete(STORES.voiceNotes, [bookId, noteId]);
}

// ---------- Settings (avec valeurs par défaut) ----------
const DEFAULT_SETTINGS = {
  wpm: 220,
  coverageThreshold: 0.8,
  theme: 'dark',
  persistGranted: false,
  ocrLangs: 'eng+fra',
};
export async function getSetting(key) {
  const db = await getDB();
  const rec = await db.get(STORES.settings, key);
  return rec ? rec.value : DEFAULT_SETTINGS[key];
}
export async function setSetting(key, value) {
  const db = await getDB();
  await db.put(STORES.settings, { key, value });
  return value;
}
export async function getAllSettings() {
  const out = { ...DEFAULT_SETTINGS };
  const db = await getDB();
  for (const rec of await db.getAll(STORES.settings)) out[rec.key] = rec.value;
  return out;
}
