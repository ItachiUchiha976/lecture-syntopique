// Comptage de mots (sert à l'indexation et au temps de lecture estimé, Phase 6).
export function countWords(text) {
  if (!text) return 0;
  const m = String(text).trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Heuristique : la page a-t-elle une vraie couche de texte (sinon -> OCR) ?
export function hasRealText(text) {
  if (!text) return false;
  return String(text).replace(/\s+/g, '').length >= 8;
}
