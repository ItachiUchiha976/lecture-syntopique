// Verrou d'OCR : garantit qu'un livre est CHERCHABLE (indexé + OCR précise terminée) AVANT de
// pouvoir l'ouvrir. Tant que l'OCR des pages scannées n'est pas finie, on affiche un écran de
// blocage avec une barre de progression et un temps restant estimé. Les PDF natifs (texte déjà
// présent) s'ouvrent immédiatement, sans attente.
import { el, escapeHtml } from '../utils.js';
import * as store from '../storage.js';
import { indexBook, isIndexed } from '../text-indexer.js';
import { OCR_VERSION, prepareReocr, ocrBook, onOcrProgress } from '../ocr.js';

// Formate un temps restant (ms) en libellé court et lisible.
function fmtEta(ms) {
  if (ms == null || !isFinite(ms) || ms <= 0) return null;
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return 'moins d’une minute';
  const min = Math.round(sec / 60);
  return `~${min} min`;
}

// Affiche l'écran de blocage et résout à true quand l'OCR est terminée, ou false si l'utilisateur
// choisit « Retour à la bibliothèque » (l'OCR continue alors en arrière-plan et reprendra).
function showGate(book) {
  return new Promise((resolve) => {
    let finished = false, unsub = null;

    const bar = el('span');
    const pageLine = el('p', { class: 'ocr-gate__pages', text: 'Préparation de la reconnaissance…' });
    const etaLine = el('p', { class: 'ocr-gate__eta', text: 'Estimation du temps en cours…' });
    const backBtn = el('button', { class: 'btn btn--ghost', text: 'Retour à la bibliothèque', onClick: () => done(false) });

    const card = el('div', { class: 'dialog ocr-gate', role: 'dialog', 'aria-modal': 'true' }, [
      el('h3', { text: '🔎 Reconnaissance du texte (OCR)' }),
      el('p', {
        class: 'ocr-gate__intro',
        html: `Pour pouvoir <strong>rechercher des mots dans « ${escapeHtml(book.title)} »</strong>, le texte de ses pages scannées doit d’abord être reconnu avec précision. Merci de patienter : le PDF s’ouvrira <strong>automatiquement dès la fin</strong>.`,
      }),
      el('div', { class: 'progress-line', style: { marginTop: '12px' } }, [bar]),
      pageLine,
      etaLine,
      el('div', { class: 'dialog__actions' }, [backBtn]),
    ]);
    const overlay = el('div', { class: 'overlay ocr-gate-overlay' }, [card]);
    document.body.appendChild(overlay);

    const done = (ok) => {
      if (finished) return;
      finished = true;
      if (unsub) unsub();
      overlay.style.transition = 'opacity .15s ease';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 150);
      resolve(ok);
    };

    const update = (e) => {
      const total = e.total || 0, d = e.done || 0;
      bar.style.width = (total ? Math.round((d / total) * 100) : 0) + '%';
      // Tant que la 1ʳᵉ page n'est pas finie, on ne connaît pas encore le temps : message clair.
      pageLine.textContent = total ? `Page ${Math.min(d + 1, total)} sur ${total}…` : 'Analyse de la 1ʳᵉ page…';
      const eta = fmtEta(e.etaMs);
      etaLine.textContent = eta
        ? `Temps restant estimé : ${eta}`
        : (d > 0 ? 'Bientôt terminé…' : 'Calcul du temps en cours…');
    };

    unsub = onOcrProgress((e) => {
      if (!e || e.bookId !== book.id) return;
      if (e.retry) { pageLine.textContent = `Nouvelle tentative (${e.retry}/${e.attempts})…`; etaLine.textContent = 'L’OCR a rencontré un souci, on réessaie…'; return; }
      if (e.failed) { done(true); return; } // 3 échecs → on ouvre quand même (lecture seule, sans recherche)
      update(e);
      if (e.finished || (e.total > 0 && e.done >= e.total)) done(true);
    });

    // Lance (ou rejoint) l'OCR. NB : on NE se fie PAS à la promesse d'ocrBook pour conclure — si une
    // OCR de fond tourne déjà, ocrBook revient aussitôt (garde anti-doublon) ; ce sont les évènements
    // `finished`/`failed` qui font foi. En cas d'erreur inattendue, on débloque la lecture (jamais piégé).
    ocrBook(book).catch(async (err) => {
      console.warn('[ocr-gate]', err);
      try { await store.updateBook(book.id, { ocrStatus: 'error', ocrFailCount: 3 }); } catch {}
      done(true);
    });

    // Garde-fou anti-course : si l'OCR s'est déjà terminée (ou a échoué) juste avant l'abonnement, on conclut.
    store.getBook(book.id).then((b) => {
      if (!b) return;
      if (b.ocrStatus === 'error') return done(true);
      if ((b.ocrStatus === 'done' || b.ocrStatus === 'not-needed') && (b.pagesNeedingOcr || 0) === 0) done(true);
    }).catch(() => {});
  });
}

// Garantit qu'un livre est cherchable avant ouverture. Renvoie true si on peut ouvrir, false si
// l'utilisateur a préféré revenir à la bibliothèque (OCR non terminée).
export async function ensureBookSearchable(book) {
  if (!book) return true;
  let b = (await store.getBook(book.id)) || book;

  // 1) S'assurer que le texte natif a été indexé (rapide) — détermine si une OCR est nécessaire.
  if (!isIndexed(b)) {
    try { await indexBook(b); } catch (e) { console.warn('[gate] index', e); }
    b = (await store.getBook(book.id)) || b;
  }

  // OCR déjà échouée 3× sur ce livre → on NE re-bloque PAS à chaque ouverture : lecture directe
  // (la bibliothèque l'affiche « OCR échouée » ; un bouton « Réessayer l'OCR » permet de relancer).
  if (b.ocrStatus === 'error') return true;

  // 2) PDF entièrement natif → texte déjà cherchable, aucune OCR. (Et 'unknown' = index échoué :
  //    on n'enferme pas l'utilisateur, on laisse ouvrir.)
  if (b.textSource !== 'scanned' && b.textSource !== 'mixed') return true;

  // 3) Re-OCR si la reconnaissance existante date d'une version moins précise.
  if (b.ocrVersion !== OCR_VERSION) {
    try { await prepareReocr(b); } catch (e) { console.warn('[gate] reocr', e); }
    b = (await store.getBook(book.id)) || b;
  }

  // 4) Reste-t-il des pages à reconnaître ? Sinon, ouverture immédiate.
  const pending = (b.pagesNeedingOcr || 0) > 0 || b.ocrStatus === 'running' || b.ocrStatus === 'pending';
  if (!pending) return true;

  return showGate(b);
}
