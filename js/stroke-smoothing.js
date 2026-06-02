// Lissage des tracés à main levée (compense l'absence de getCoalescedEvents sur
// Safari). On simplifie (suppression des points trop proches) puis on dessine
// avec des courbes quadratiques passant par les milieux de segments.

export function simplifyPath(points, minDist = 2) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) { out.push(p); last = p; }
  }
  const end = points[points.length - 1];
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

// Trace un chemin lissé dans le contexte courant (sans beginPath/fill : à gérer par l'appelant).
export function tracePath(ctx, pts) {
  if (!pts.length) return;
  if (pts.length < 3) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    return;
  }
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2;
    const yc = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
  }
  const n = pts.length;
  ctx.quadraticCurveTo(pts[n - 2].x, pts[n - 2].y, pts[n - 1].x, pts[n - 1].y);
}

// Point dans polygone (ray casting). poly = [{x,y}...].
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
