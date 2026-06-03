// Schéma IndexedDB + ouverture/migrations.
// Utilise la petite lib `idb` (wrapper Promise) vendorisée.
import { openDB } from '../vendor/idb/index.js';

export const DB_NAME = 'syntopique-db';
export const DB_VERSION = 2;

// Stores :
//  - books            (key 'id')                  : métadonnées d'un livre
//  - pages            (key ['bookId','pageIndex']) : texte + état de censure par page
//  - readingProgress  (key 'bookId')              : suivi de lecture anti-triche
//  - settings         (key 'key')                 : réglages
//  - blobs            (key 'key')                 : repli binaire si OPFS indisponible
//  - voiceNotes       (key ['bookId','noteId'])   : notes vocales de connexion (méta ; l'audio est un binaire)
export const STORES = {
  books: 'books',
  pages: 'pages',
  readingProgress: 'readingProgress',
  settings: 'settings',
  blobs: 'blobs',
  voiceNotes: 'voiceNotes',
};

let _dbPromise = null;

export function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const books = db.createObjectStore(STORES.books, { keyPath: 'id' });
        books.createIndex('byImportedAt', 'importedAt');
        books.createIndex('byLastOpenedAt', 'lastOpenedAt');

        const pages = db.createObjectStore(STORES.pages, { keyPath: ['bookId', 'pageIndex'] });
        pages.createIndex('byBook', 'bookId');

        db.createObjectStore(STORES.readingProgress, { keyPath: 'bookId' });
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
        db.createObjectStore(STORES.blobs, { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        // Notes vocales : une note par (livre, noteId). L'audio binaire vit dans OPFS/blobs,
        // référencé par `audioRef`. Indexes pour lister par livre et trier par date.
        const notes = db.createObjectStore(STORES.voiceNotes, { keyPath: ['bookId', 'noteId'] });
        notes.createIndex('byBook', 'bookId');
        notes.createIndex('byCreatedAt', 'createdAt');
      }
      // Les futures migrations (DB_VERSION > 2) viendront ici.
    },
    blocked() { console.warn('[db] mise à jour bloquée par un autre onglet'); },
    blocking() {
      // Un autre contexte veut migrer vers une version plus récente : on FERME notre connexion
      // pour ne pas bloquer l'upgrade (sinon getDB() ailleurs ne résoudrait jamais → boot figé).
      if (_dbPromise) { _dbPromise.then((db) => { try { db.close(); } catch {} }).catch(() => {}); _dbPromise = null; }
    },
  });
  return _dbPromise;
}
