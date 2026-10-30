// Top-down field diagram (SVG) with fielders placed by alignment.
import { esc } from './util.js';

const HOME = [200, 338];
const B1 = [266, 272], B2 = [200, 206], B3 = [134, 272];
const BASE_POS = { 1: [200, 270], 2: [200, 358], 3: [262, 244], 4: [234, 206], 5: [138, 244], 6: [166, 206], 7: [112, 136], 8: [200, 92], 9: [288, 136] };
const POS_ABBR = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF' };

function placeFor(pos, align, batSide) {
  let [x, y] = BASE_POS[pos];
  const a = align || {};
  if (pos >= 3 && pos <= 6) {
    if (a.inf === 'in') { const t = 0.32; x += (HOME[0] - x) * t * 0.5; y += (HOME[1] - y) * t * 0.55; }
    if (a.inf === 'dp' && (pos === 4 || pos === 6)) { x += (B2[0] - x) * 0.35; y += 6; }
    if (a.inf === 'corners' && (pos === 3 || pos === 5)) { x += (HOME[0] - x) * 0.18; y += 16; }
    if (a.inf === 'lines' && (pos === 3 || pos === 5)) { x += pos === 3 ? 10 : -10; y += 8; }
  }
  if (pos >= 7) {
    const dx = x - HOME[0], dy = y - HOME[1];
    const len = Math.hypot(dx, dy);
    const k = a.of === 'deep' ? 26 : a.of === 'shallow' ? -30 : 0;
    x += (dx / len) * k; y += (dy / len) * k;
  }
  if (a.shift && batSide === 'L') {
    if (pos === 6) { x = 236; y = 196; }
    if (pos === 5) { x = 168; y = 208; }
    if (pos === 4) { x = 262; y = 186; }
  }
  return [x, y];
}

export function renderField(g, last) {
  const ft = g.fld(), bt = g.bat();
  const f = g.fielders(ft);
  const batter = g.P(g.batter().pid);
  const pit = g.pitcherObj();
  const side = batter.b === 'B' ? (pit.t === 'L' ? 'R' : 'L') : batter.b;
  const fColor = ft.side === 0 ? 'var(--away)' : 'var(--home)';
  const bColor = bt.side === 0 ? 'var(--away)' : 'var(--home)';
  let s = `<svg viewBox="0 0 400 384" role="img" aria-label="Field: ${esc(describe(g))}">
  <defs><clipPath id="fair"><path d="M200 338 L18 156 A258 258 0 0 1 382 156 Z"/></clipPath></defs>
  <rect width="400" height="384" fill="var(--grass-2)" rx="12"/>
  <path d="M200 338 L18 156 A258 258 0 0 1 382 156 Z" fill="var(--grass)"/>
  <g clip-path="url(#fair)" opacity=".18">${Array.from({ length: 9 }, (_, i) => `<path d="M${-40 + i * 60} 0 L${20 + i * 60} 372" stroke="var(--chalk)" stroke-width="14"/>`).join('')}</g>
  <circle cx="200" cy="262" r="100" fill="var(--dirt)" clip-path="url(#fair)"/>
  <path d="M200 326 L250 276 L200 226 L150 276 Z" fill="var(--grass)"/>
  <circle cx="200" cy="270" r="13" fill="var(--dirt)"/>
  <rect x="196" y="268" width="8" height="2.5" fill="var(--chalk)"/>
  <circle cx="200" cy="338" r="22" fill="var(--dirt)"/>
  <path d="M200 338 L18 156 M200 338 L382 156" stroke="var(--chalk)" stroke-width="2"/>
  <path d="M194 336 h12 v4 l-6 5 l-6 -5 z" fill="var(--chalk)"/>`;
  // bases
  for (const [i, [x, y]] of [B1, B2, B3].entries()) {
    const occ = g.bases[i];
    s += `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" transform="rotate(45 ${x} ${y})" fill="${occ ? 'var(--accent)' : 'var(--chalk)'}" stroke="rgba(0,0,0,.25)"/>`;
  }
  // last batted ball
  if (last && last.prof) {
    const p = last.prof;
    let [tx, ty] = BASE_POS[p.field] || BASE_POS[8];
    if (p.field >= 7) {
      const dx = tx - HOME[0], dy = ty - HOME[1], len = Math.hypot(dx, dy);
      const k = p.depth === 'deep' ? 40 : p.depth === 'shallow' ? -40 : 0;
      tx += (dx / len) * k; ty += (dy / len) * k;
      if (last.category === 'HR') { tx += (dx / len) * 70; ty += (dy / len) * 70; }
    }
    const curve = p.bb === 'G' ? '' : ` Q ${(HOME[0] + tx) / 2} ${Math.min(HOME[1], ty) - 40} ${tx} ${ty}`;
    s += p.bb === 'G' ? `<path d="M200 334 L${tx} ${ty}" stroke="var(--chalk)" stroke-width="2" stroke-dasharray="4 4" fill="none"/>`
      : `<path d="M200 334${curve}" stroke="var(--chalk)" stroke-width="2" stroke-dasharray="4 4" fill="none"/>`;
    s += `<circle cx="${tx}" cy="${ty}" r="4" fill="var(--chalk)" stroke="rgba(0,0,0,.4)"/>`;
  }
  // fielders
  for (let pos = 1; pos <= 9; pos++) {
    const pid = f[pos];
    if (!pid) continue;
    const [x, y] = placeFor(pos, ft.align, side);
    const pl = g.P(pid);
    s += `<g><title>${esc(pl.n)} (${POS_ABBR[pos]})</title><circle cx="${x}" cy="${y}" r="9" fill="${fColor}" stroke="var(--chalk)" stroke-width="2"/>
      <text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="var(--font-body)">${POS_ABBR[pos]}</text>
      <text x="${x}" y="${pos === 2 ? y + 19 : y + 21}" text-anchor="middle" font-size="9.5" fill="var(--chalk)" font-family="var(--font-body)" font-weight="600" paint-order="stroke" stroke="rgba(0,0,0,.35)" stroke-width="2.5">${esc(pl.l || pl.n)}</text></g>`;
  }
  // runners
  for (const [i, [x, y]] of [B1, B2, B3].entries()) {
    const r = g.bases[i];
    if (!r) continue;
    const off = i === 0 ? [30, 14] : i === 1 ? [0, -20] : [-30, 14];
    s += `<g><circle cx="${x}" cy="${y - 1}" r="7" fill="${bColor}" stroke="var(--accent)" stroke-width="2.5"/>
      <text x="${x + off[0]}" y="${y + off[1] - 6}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" font-size="10" font-weight="700" fill="var(--chalk)" font-family="var(--font-body)" paint-order="stroke" stroke="rgba(0,0,0,.55)" stroke-width="3">${esc(r.name)}</text></g>`;
  }
  // batter in the box (catcher's left for righties as seen from behind the plate)
  const bx = side === 'L' ? 226 : 174;
  s += `<g><circle cx="${bx}" cy="${HOME[1] - 2}" r="7" fill="${bColor}" stroke="var(--chalk)" stroke-width="2"/>
    <text x="${side === 'L' ? bx + 12 : bx - 12}" y="${HOME[1] + 2}" text-anchor="${side === 'L' ? 'start' : 'end'}" font-size="10" font-weight="700" fill="var(--chalk)" font-family="var(--font-body)" paint-order="stroke" stroke="rgba(0,0,0,.55)" stroke-width="3">${esc(batter.l || batter.n)}</text></g>`;
  s += `</svg>`;
  return s;
}

function describe(g) {
  const occ = ['first', 'second', 'third'].filter((_, i) => g.bases[i]);
  return `${g.outs} out, ${occ.length ? 'runners on ' + occ.join(' and ') : 'bases empty'}`;
}
