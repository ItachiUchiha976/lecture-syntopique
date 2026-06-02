// Wrapper autour de PDF.js (v6, build ESM vendorisé).
// Configure le worker et les ressources OFFLINE (polices standard, WASM de
// décodage d'images, profils ICC). Expose des helpers de haut niveau.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

export { pdfjsLib };

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url);

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;

// Options communes à tout chargement de document, pour un rendu fidèle hors-ligne.
const DOC_OPTS = {
  standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
  wasmUrl: new URL('wasm/', VENDOR).href,
  iccUrl: new URL('iccs/', VENDOR).href,
  // cMapUrl non fourni : les cmaps CJK ne sont pas nécessaires pour fr/en.
  isEvalSupported: false,        // plus sûr
};

export class PdfPasswordError extends Error {
  constructor(needed) { super('PDF protégé par mot de passe'); this.name = 'PdfPasswordError'; this.needed = needed; }
}

// Charge un document depuis des octets. `onPassword(reason)` doit renvoyer un mdp
// (ou Promise), sinon une PdfPasswordError est levée.
export async function loadDocument(bytes, { onPassword } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = pdfjsLib.getDocument({ data, ...DOC_OPTS });
  if (onPassword) {
    task.onPassword = async (updatePassword, reason) => {
      // reason: 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD
      const pwd = await onPassword(reason);
      if (pwd == null) { task.destroy(); throw new PdfPasswordError(true); }
      updatePassword(pwd);
    };
  }
  return task.promise;
}

// Détruit proprement un document : en PDF.js v6, c'est le loadingTask qui porte
// destroy() (le proxy de document ne l'expose pas directement).
export function destroyDoc(pdfDoc) {
  try {
    if (!pdfDoc) return undefined;
    if (pdfDoc.loadingTask && typeof pdfDoc.loadingTask.destroy === 'function') return pdfDoc.loadingTask.destroy();
    if (typeof pdfDoc.destroy === 'function') return pdfDoc.destroy();
  } catch (e) { console.warn('[pdf] destroy()', e); }
  return undefined;
}

export async function getDocInfo(pdfDoc) {
  const numPages = pdfDoc.numPages;
  let title = '';
  try {
    const md = await pdfDoc.getMetadata();
    title = (md && md.info && md.info.Title) ? String(md.info.Title).trim() : '';
  } catch {}
  const p1 = await pdfDoc.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  const firstSize = { w: vp.width, h: vp.height };
  p1.cleanup();
  return { numPages, title, firstSize };
}

// Taille native (unités PDF) d'une page donnée (1-based).
export async function getPageSize(pdfDoc, pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const size = { w: vp.width, h: vp.height };
  page.cleanup();
  return size;
}

// Construit une couche de texte sélectionnable (spans positionnés) dans `container`.
// `viewport` doit être à l'échelle D'AFFICHAGE (CSS px), pas à l'échelle du canvas.
// Retourne l'objet TextLayer (avec textDivs[] et textContentItemsStr[]).
export async function buildTextLayer(page, viewport, container) {
  const textContent = await page.getTextContent();
  container.style.setProperty('--scale-factor', String(viewport.scale));
  const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport });
  await tl.render();
  return tl;
}

// Rend la page 1 en vignette JPEG (Blob) tenant dans `maxPx`.
export async function renderThumbnail(pdfDoc, maxPx = 420) {
  const page = await pdfDoc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = maxPx / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  canvas.width = canvas.height = 0; // libère la mémoire canvas (important sur iPad)
  return blob;
}
