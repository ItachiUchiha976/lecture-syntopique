// Normalisation de texte pour une recherche insensible à la CASSE et aux ACCENTS.
// "batons" doit correspondre à "Bâtons", "BATONS", "BâTONS", "BaTOnS", etc.
//
// Méthode : décomposition Unicode (NFD) qui sépare lettre + diacritique, puis
// suppression des diacritiques combinants, puis passage en minuscules.

const COMBINING = /[̀-ͯ]/g;

// Normalise une chaîne entière (pour une requête de recherche).
export function normalizeQuery(s) {
  return String(s).normalize('NFD').replace(COMBINING, '').toLowerCase().trim();
}

// Normalise un caractère unique (transforme local : accents + casse).
function normalizeChar(c) {
  return c.normalize('NFD').replace(COMBINING, '').toLowerCase();
}

// Construit la version normalisée d'un texte ET une table de correspondance
// position_normalisée -> index du caractère ORIGINAL d'où elle provient.
// Indispensable pour surligner précisément (NFD/lowercase peuvent changer la
// longueur : 'â' -> 'a', 'ﬁ' inchangé, 'İ' -> 'i̇', etc.).
export function buildNormIndex(text) {
  const src = String(text);
  let norm = '';
  const map = []; // map[k] = index dans `src` du k-ième caractère de `norm`
  for (let i = 0; i < src.length; i++) {
    const nc = normalizeChar(src[i]);
    for (let j = 0; j < nc.length; j++) { norm += nc[j]; map.push(i); }
  }
  return { norm, map };
}

// Recherche toutes les occurrences de `query` (déjà normalisée) dans `norm`.
// Retourne des intervalles d'index ORIGINAUX via la table `map`.
// origLength = longueur du texte source (pour borner la fin).
export function findMatches(norm, map, query, origLength) {
  const out = [];
  if (!query) return out;
  let from = 0;
  while (true) {
    const idx = norm.indexOf(query, from);
    if (idx === -1) break;
    const startOrig = map[idx];
    const endNorm = idx + query.length - 1;
    // fin = caractère original suivant le dernier caractère normalisé matché
    const endOrig = (endNorm + 1 < map.length) ? map[endNorm + 1] : origLength;
    out.push({ start: startOrig, end: endOrig }); // intervalle [start, end) en indices originaux
    from = idx + query.length;
  }
  return out;
}
