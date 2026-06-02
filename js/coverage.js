// Calcul du pourcentage de page couvert par les censures.
// Méthode par MASQUE DE PIXELS : on peint toutes les formes en opaque sur un
// canvas hors-écran réduit, puis on compte les pixels non transparents / total.
// -> gère exactement les chevauchements (union), sans double comptage.

const SAMPLE_MAX = 1000; // côté max du canvas de mesure (précision suffisante, ~4 Mo)

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// marks en unités PDF (origine haut-gauche). Retourne une fraction 0..1.
export function computeCoverage(marks, nativeW, nativeH) {
  if (!marks || !marks.length || !nativeW || !nativeH) return 0;
  const scale = SAMPLE_MAX / Math.max(nativeW, nativeH);
  const cw = Math.max(1, Math.round(nativeW * scale));
  const ch = Math.max(1, Math.round(nativeH * scale));
  const canvas = makeCanvas(cw, ch);
  if (canvas.width !== cw) { canvas.width = cw; canvas.height = ch; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = '#000';
  for (const m of marks) {
    if (m.type === 'rect') {
      ctx.fillRect(m.rect.x * scale, m.rect.y * scale, m.rect.w * scale, m.rect.h * scale);
    } else if (m.type === 'highlight') {
      for (const q of m.quads) ctx.fillRect(q.x * scale, q.y * scale, q.w * scale, q.h * scale);
    } else if (m.type === 'marker' && m.path && m.path.length) {
      ctx.save();
      ctx.strokeStyle = '#000'; ctx.lineWidth = (m.width || 0) * scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(m.path[0].x * scale, m.path[0].y * scale);
      for (let k = 1; k < m.path.length; k++) ctx.lineTo(m.path[k].x * scale, m.path[k].y * scale);
      if (m.path.length === 1) ctx.lineTo(m.path[0].x * scale + 0.1, m.path[0].y * scale);
      ctx.stroke();
      ctx.restore();
    } else if (m.type === 'lasso' && m.path && m.path.length > 2) {
      ctx.beginPath();
      ctx.moveTo(m.path[0].x * scale, m.path[0].y * scale);
      for (let k = 1; k < m.path.length; k++) ctx.lineTo(m.path[k].x * scale, m.path[k].y * scale);
      ctx.closePath();
      ctx.fill();
    }
  }
  const data = ctx.getImageData(0, 0, cw, ch).data;
  const total = cw * ch;
  let covered = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) covered++; // canal alpha
  return covered / total;
}
