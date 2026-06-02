// Ouverture d'un livre : récupère le binaire stocké et instancie le document PDF.js.
// Réutilisé par le lecteur simple et le lecteur double.
import * as store from './storage.js';
import { loadDocument } from './pdf-engine.js';
import { promptDialog } from './ui/dialogs.js';

export async function openBookDoc(bookId) {
  const book = await store.getBook(bookId);
  if (!book) throw new Error('Livre introuvable.');
  const bytes = await store.loadBinary(book.binaryRef);
  if (!bytes) throw new Error('Le fichier PDF est introuvable dans le stockage.');
  const pdfDoc = await loadDocument(bytes, {
    onPassword: async (reason) => promptDialog({
      title: 'PDF protégé',
      message: reason === 2 ? 'Mot de passe incorrect. Réessaie :' : 'Ce PDF demande un mot de passe :',
      type: 'password', okText: 'Ouvrir',
    }),
  });
  store.updateBook(bookId, { lastOpenedAt: Date.now() }).catch(() => {});
  return { book, pdfDoc };
}
