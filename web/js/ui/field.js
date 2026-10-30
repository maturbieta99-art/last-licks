// The ballpark at night: a floodlit field drawn in SVG from a camera high
// behind home plate. Positions are laid out top-down (home at 200,338, center
// field toward y=0) and projected; straight lines stay straight.
import { esc } from './util.js';
import { speedLabel } from './art.js';

const HOME = [200, 338];
const B1 = [266, 272], B2 = [200, 206], B3 = [134, 272];
const BASES = [B1, B2, B3];
const BASE_POS = { 1: [200, 270], 2: [200, 358], 3: [262, 244], 4: [234, 206], 5: [138, 244], 6: [166, 206], 7: [112, 136], 8: [200, 92], 9: [288, 136] };
const POS_ABBR = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF' };
const FENCE = 258;
const W = 400, H = 300;

// camera: k sets the perspective, c the tilt, S the zoom, Y0 where home sits
const K = 0.0012, TILT = 0.8, S = 1.22, Y0 = 268;
function depth(y) { return 1 / (1 + K * (HOME[1] - y)); }
export function proj(x, y) {
  const s = depth(y);
  return [200 + S * (x - 200) * s, Y0 - S * TILT * (HOME[1] - y) * s];
}
const pt = ([x, y]) => proj(x, y).map((v) => v.toFixed(1)).join(' ');
const poly = (pts) => 'M' + pts.map(pt).join(' L') + ' Z';
const line = (pts) => 'M' + pts.map(pt).join(' L');
function arc(cx, cy, r, a0, a1, n = 40) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    out.push([cx + r * Math.sin(a), cy - r * Math.cos(a)]);
  }
  return out;
}
const DEG = Math.PI / 180;

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

// Static ballpark (everything that never moves), built once.
let PARK = null;
function park() {
  if (PARK) return PARK;
  const wallArc = arc(HOME[0], HOME[1], FENCE, -64 * DEG, 64 * DEG, 64);
  const fair = [HOME, ...arc(HOME[0], HOME[1], FENCE, -45 * DEG, 45 * DEG, 48)];
  const track = arc(HOME[0], HOME[1], FENCE - 13, -45 * DEG, 45 * DEG, 48);
  const ground = 'M' + wallArc.map(pt).join(' L') + ' L 520 330 L -120 330 Z';
  // the wall stands up from the fence line
  const top = wallArc.map(([x, y]) => { const [px, py] = proj(x, y); return [px, py - 15 * S * depth(y)]; });
  const wall = 'M' + wallArc.map(pt).join(' L') + ' L' + top.slice().reverse().map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L') + ' Z';
  const wallTop = 'M' + top.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L');
  const stands = 'M' + top.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L') + ' L 520 -10 L -120 -10 Z';
  // mowing: two sets of stripes parallel to the foul lines make the checkerboard
  let mow = '';
  for (let i = 0; i < 11; i += 2) {
    const a = 26 * i, b = a + 26;
    // stripes parallel to the first-base line (direction (1,-1)) and the third-base line (-1,-1)
    mow += `<path d="${poly([[HOME[0] - a / Math.SQRT2 + 0, HOME[1] - a / Math.SQRT2], [HOME[0] - b / Math.SQRT2, HOME[1] - b / Math.SQRT2], [HOME[0] - b / Math.SQRT2 + 420, HOME[1] - b / Math.SQRT2 - 420], [HOME[0] - a / Math.SQRT2 + 420, HOME[1] - a / Math.SQRT2 - 420]])}" />`;
    mow += `<path d="${poly([[HOME[0] + a / Math.SQRT2, HOME[1] - a / Math.SQRT2], [HOME[0] + b / Math.SQRT2, HOME[1] - b / Math.SQRT2], [HOME[0] + b / Math.SQRT2 - 420, HOME[1] - b / Math.SQRT2 - 420], [HOME[0] + a / Math.SQRT2 - 420, HOME[1] - a / Math.SQRT2 - 420]])}" />`;
  }
  const dirt = arc(200, 262, 100, -90 * DEG, 90 * DEG, 40);
  const dirtPoly = poly([[200 - 100, 262], ...dirt, [300, 262], [266 + 40, 338 - 26], HOME, [134 - 40, 338 - 26]]);
  const infieldGrass = poly([[200, 326], [250, 276], [200, 226], [150, 276]]);
  const mound = poly(arc(200, 270, 13, 0, 360 * DEG, 24));
  const homeDirt = poly(arc(200, 338, 24, 0, 360 * DEG, 28));
  const baseSq = (x, y, d = 5) => poly([[x - d, y], [x, y - d], [x + d, y], [x, y + d]]);
  const plate = poly([[195, 336], [205, 336], [205, 339.5], [200, 343], [195, 339.5]]);
  const boxes = [[[183, 330], [193, 330], [193, 348], [183, 348]], [[207, 330], [217, 330], [217, 348], [207, 348]]]
    .map((b) => `<path d="${poly(b)}" fill="none" stroke="var(--chalk)" stroke-opacity=".55" stroke-width=".9"/>`).join('');
  const [plx, ply] = proj(18, 156), [prx, pry] = proj(382, 156);
  const poleH = 34;
  const crowd = `<pattern id="crowd" width="7" height="5" patternUnits="userSpaceOnUse">
      <rect width="7" height="5" fill="#050506"/><circle cx="1.5" cy="1.5" r=".9" fill="#2a2a30"/><circle cx="5" cy="3.4" r=".8" fill="#3a3530"/><circle cx="3.4" cy="4.6" r=".5" fill="#1c1c22"/></pattern>`;
  const lights = [[46, 10], [118, 4], [282, 4], [354, 10]].map(([x, y]) => `<g transform="translate(${x} ${y})">
      <ellipse cx="0" cy="6" rx="46" ry="26" fill="url(#flare)"/>
      ${Array.from({ length: 6 }, (_, i) => `<circle cx="${-7.5 + (i % 3) * 7.5}" cy="${3 + Math.floor(i / 3) * 5}" r="1.9" fill="#fffbea"/>`).join('')}</g>`).join('');
  PARK = `<defs>
      <radialGradient id="flood" cx="50%" cy="58%" r="62%"><stop offset="0" stop-color="#fff8dc" stop-opacity=".2"/><stop offset=".55" stop-color="#fff8dc" stop-opacity=".05"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
      <radialGradient id="flare"><stop offset="0" stop-color="#fff6d5" stop-opacity=".55"/><stop offset=".35" stop-color="#ffe9a8" stop-opacity=".16"/><stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/></radialGradient>
      <linearGradient id="grassG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--grass-far)"/><stop offset="1" stop-color="var(--grass)"/></linearGradient>
      <linearGradient id="dirtG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--dirt-far)"/><stop offset="1" stop-color="var(--dirt)"/></linearGradient>
      <clipPath id="fairClip"><path d="${poly(fair)}"/></clipPath>
      <clipPath id="groundClip"><path d="${ground}"/></clipPath>
      ${crowd}
    </defs>
    <rect width="${W}" height="${H}" fill="#000"/>
    <path d="${stands}" fill="url(#crowd)" opacity=".9"/>
    ${lights}
    <path d="${ground}" fill="var(--grass-foul)"/>
    <path d="${poly(fair)}" fill="url(#grassG)"/>
    <g clip-path="url(#fairClip)" fill="#fff" opacity=".045">${mow}</g>
    <path d="${'M' + track.map(pt).join(' L') + ' L' + arc(HOME[0], HOME[1], FENCE, 45 * DEG, -45 * DEG, 48).map(pt).join(' L') + ' Z'}" fill="var(--dirt-far)" opacity=".85"/>
    <path d="${dirtPoly}" fill="url(#dirtG)" clip-path="url(#fairClip)"/>
    <path d="${homeDirt}" fill="var(--dirt)"/>
    <path d="${infieldGrass}" fill="var(--grass)"/>
    <path d="${mound}" fill="var(--dirt)"/>
    <path d="${poly([[196, 269], [204, 269], [204, 271], [196, 271]])}" fill="var(--chalk)"/>
    <path d="${line([HOME, [18, 156]])} ${line([HOME, [382, 156]])}" stroke="var(--chalk)" stroke-width="1.6" fill="none"/>
    ${boxes}
    <path d="${plate}" fill="var(--chalk)"/>
    ${BASES.map(([x, y]) => `<path d="${baseSq(x, y)}" fill="var(--chalk)" class="base"/>`).join('')}
    <path d="${wall}" fill="#0b2216"/>
    <path d="${wallTop}" stroke="#d9b54a" stroke-width="1.4" fill="none" opacity=".9"/>
    <path d="M${plx.toFixed(1)} ${ply.toFixed(1)} L${plx.toFixed(1)} ${(ply - poleH).toFixed(1)} M${prx.toFixed(1)} ${pry.toFixed(1)} L${prx.toFixed(1)} ${(pry - poleH).toFixed(1)}" stroke="#e2bf52" stroke-width="2"/>
    <rect width="${W}" height="${H}" fill="url(#flood)" pointer-events="none"/>`;
  return PARK;
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Path a runner takes between two bases (-1 = home plate as the batter, 3 = home as a run).
function runPath(from, to) {
  const stops = [];
  const at = (b) => (b === -1 || b === 3 ? HOME : BASES[b]);
  for (let b = from; b <= to; b++) stops.push(at(b));
  return stops.map((p) => proj(...p));
}

function bolt(x, y, s = 1) {
  return `<path d="M${x + 2.6 * s} ${y - 4.2 * s} L${x - 1.2 * s} ${y + 0.6 * s} L${x + 0.6 * s} ${y + 0.6 * s} L${x - 1.4 * s} ${y + 4.4 * s} L${x + 2.8 * s} ${y - 0.8 * s} L${x + 0.8 * s} ${y - 0.8 * s} Z" fill="var(--accent)"/>`;
}

// g: the game; fx: one-shot animation info for the play that just happened
// { ball: play event, prev: [pid|null x3], batter: pid, scored: [pid...] }
export function renderField(g, last, fx = null, keyRuns = {}) {
  const ft = g.fld(), bt = g.bat();
  const f = g.fielders(ft);
  const batter = g.P(g.batter().pid);
  const pit = g.pitcherObj();
  const side = batter.b === 'B' ? (pit.t === 'L' ? 'R' : 'L') : batter.b;
  const fColor = ft.side === 0 ? 'var(--away)' : 'var(--home)';
  const bColor = bt.side === 0 ? 'var(--away)' : 'var(--home)';
  const animate = !!fx && !reduceMotion();
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Field: ${esc(describe(g))}">${park()}`;

  // last batted ball: where it went (animated only right after the play)
  const ball = fx && fx.ball ? fx.ball : last;
  const fly = animate && !!fx.ball;
  let chase = null;
  if (ball && ball.prof) {
    const p = ball.prof;
    let [tx, ty] = BASE_POS[p.field] || BASE_POS[8];
    if (p.field >= 7) {
      const dx = tx - HOME[0], dy = ty - HOME[1], len = Math.hypot(dx, dy);
      const k = p.depth === 'deep' ? 40 : p.depth === 'shallow' ? -40 : 0;
      tx += (dx / len) * k; ty += (dy / len) * k;
      if (ball.category === 'HR') { tx += (dx / len) * 76; ty += (dy / len) * 76; }
    }
    const [hx, hy] = proj(200, 334);
    const [lx, ly] = proj(tx, ty);
    const dist = Math.hypot(lx - hx, ly - hy);
    const lift = p.bb === 'G' ? 0 : p.bb === 'L' ? dist * 0.22 : dist * (ball.category === 'HR' ? 0.75 : 0.6);
    const air = p.bb === 'G' ? `M${hx.toFixed(1)} ${hy.toFixed(1)} L${lx.toFixed(1)} ${ly.toFixed(1)}`
      : `M${hx.toFixed(1)} ${hy.toFixed(1)} Q${((hx + lx) / 2).toFixed(1)} ${(Math.min(hy, ly) - lift).toFixed(1)} ${lx.toFixed(1)} ${ly.toFixed(1)}`;
    const groundPath = `M${hx.toFixed(1)} ${hy.toFixed(1)} L${lx.toFixed(1)} ${ly.toFixed(1)}`;
    const dur = p.bb === 'G' ? 0.7 : ball.category === 'HR' ? 1.5 : 1.15;
    if (fly) chase = { field: p.field, x: tx, y: ty, dur, hr: ball.category === 'HR' };
    s += `<path d="${air}" class="trail ${fly ? 'draw' : ''}" style="--dur:${dur}s" pathLength="1" fill="none" stroke="var(--chalk)" stroke-width="1.6" stroke-dasharray="${fly ? '1 1' : '.012 .018'}" stroke-linecap="round"/>`;
    if (fly) {
      s += `<ellipse rx="3.2" ry="1.4" fill="#000" opacity=".5"><animateMotion dur="${dur}s" fill="freeze" path="${groundPath}"/></ellipse>
        <circle r="3.4" fill="#fff" stroke="var(--accent)" stroke-width=".8"><animateMotion dur="${dur}s" fill="freeze" path="${air}"/></circle>`;
    } else s += `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.2" fill="var(--chalk)" opacity=".85"/>`;
  }

  // fielders: farther away, a little smaller
  for (let pos = 1; pos <= 9; pos++) {
    const pid = f[pos];
    if (!pid) continue;
    const [wx, wy] = placeFor(pos, ft.align, side);
    const [x, y] = proj(wx, wy);
    const d = depth(wy) * S;
    const r = 7.6 * d;
    const pl = g.P(pid);
    let run = '';
    if (chase && chase.field === pos && !chase.hr) {
      // run most of the way to the ball, a beat after contact
      const [bx2, by2] = proj(chase.x, chase.y);
      const k = pos <= 6 ? 0.8 : 0.9;
      run = `<animateMotion dur="${(chase.dur * 0.9).toFixed(2)}s" begin=".12s" fill="freeze" path="M0 0 L${((bx2 - x) * k).toFixed(1)} ${((by2 - y) * k).toFixed(1)}"/>`;
    }
    s += `<g class="fielder">${run}<title>${esc(pl.n)} (${POS_ABBR[pos]})</title>
      <ellipse cx="${x.toFixed(1)}" cy="${(y + r * 0.9).toFixed(1)}" rx="${(r * 1.1).toFixed(1)}" ry="${(r * 0.38).toFixed(1)}" fill="#000" opacity=".45"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fColor}" stroke="#fff" stroke-opacity=".85" stroke-width="1.2"/>
      <text x="${x.toFixed(1)}" y="${(y + r * 0.36).toFixed(1)}" text-anchor="middle" font-size="${(r * 0.95).toFixed(1)}" font-weight="800" fill="#fff" font-family="var(--font-body)">${POS_ABBR[pos]}</text>
      <text class="fname" x="${x.toFixed(1)}" y="${(y + r + 9).toFixed(1)}" text-anchor="middle" font-size="8.6" fill="var(--chalk)" font-family="var(--font-body)" font-weight="600" paint-order="stroke" stroke="#000" stroke-opacity=".7" stroke-width="2.6">${esc(pl.l || pl.n)}</text></g>`;
  }

  if (chase && chase.hr) s += fireworks();

  // runners who scored on the play run home and fade out
  if (animate && fx.scoredFrom) {
    for (const from of fx.scoredFrom) {
      const pts = runPath(from, 3);
      s += `<g class="scorer"><circle r="6.4" fill="${bColor}" stroke="#fff" stroke-width="1.6"><animateMotion dur="${0.25 + 0.3 * pts.length}s" fill="freeze" path="M${pts.map((p) => p.map((v) => v.toFixed(1)).join(' ')).join(' L')}"/></circle></g>`;
    }
  }

  // runners, with speed tags
  const runKey = (i) => (keyRuns.tying && keyRuns.tying.base === i ? 'Tying run' : keyRuns.ahead && keyRuns.ahead.base === i ? keyRuns.ahead.label : '');
  for (const [i, [bx, by]] of BASES.entries()) {
    const r = g.bases[i];
    if (!r) continue;
    const [x, y] = proj(bx, by);
    const sp = speedLabel(r.spd);
    const from = animate && fx.prev ? fx.prev.indexOf(r.pid) : -2;
    const start = animate ? (from >= 0 ? from : r.pid === fx.batter ? -1 : -2) : -2;
    let motion = '';
    let at = `transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"`;
    const moving = start > -2 && start !== i;
    if (moving) {
      const pts = runPath(start, i);
      motion = `<animateMotion dur="${0.25 + 0.3 * pts.length}s" fill="freeze" path="M${pts.map((p) => p.map((v) => v.toFixed(1)).join(' ')).join(' L')}"/>`;
      at = '';
    }
    const key = runKey(i);
    const nameW = r.name.length * 5.7;
    const boltW = sp.bolts * 6 + (sp.slow ? 24 : 0);
    const wTag = 8 + nameW + 6 + boltW + 12 + 5;
    const hTag = key ? 25 : 17;
    // first and third: tag below the bag, clear of the fielder's name; second: above
    const tx0 = i === 0 ? 11 : i === 2 ? -11 - wTag : -wTag / 2;
    const ty0 = i === 1 ? -31 : 7;
    const numX = wTag - 5;
    s += `<g class="runner" ${at}>${motion}
      <ellipse cx="0" cy="6" rx="8" ry="2.6" fill="#000" opacity=".5"/>
      <circle r="7.2" fill="${bColor}" stroke="${key ? 'var(--accent)' : '#fff'}" stroke-width="${key ? 2.6 : 1.8}"/>
      <g class="rtag ${moving ? 'late' : ''}" transform="translate(${tx0.toFixed(1)} ${ty0})">
        <rect width="${wTag.toFixed(1)}" height="${hTag}" rx="3.5" fill="#050505" fill-opacity=".88" stroke="${key ? 'var(--accent)' : '#ffffff'}" stroke-opacity="${key ? 0.85 : 0.22}"/>
        <rect width="3" height="${hTag}" rx="1.5" fill="${bColor}"/>
        <text x="8" y="12" font-size="9.6" font-weight="700" fill="var(--chalk)" font-family="var(--font-body)">${esc(r.name)}</text>
        ${Array.from({ length: sp.bolts }, (_, k) => bolt(numX - 14 - (sp.bolts - k) * 6 + 2, 8.6, 0.92)).join('')}
        ${sp.slow ? `<text x="${(numX - 15).toFixed(1)}" y="11.6" text-anchor="end" font-size="7.4" font-weight="800" letter-spacing=".06em" fill="var(--muted)" font-family="var(--font-body)">SLOW</text>` : ''}
        <text x="${numX.toFixed(1)}" y="12" text-anchor="end" font-size="9.4" font-weight="800" fill="${sp.bolts ? 'var(--accent)' : sp.slow ? 'var(--muted)' : 'var(--chalk)'}" font-family="var(--font-body)">${r.spd}</text>
        ${key ? `<text x="8" y="21.5" font-size="7.2" font-weight="800" letter-spacing=".08em" fill="var(--accent)" font-family="var(--font-body)">${esc(key.toUpperCase())}</text>` : ''}
      </g></g>`;
  }

  // the batter in the box: righties stand on the third-base side
  const [px, py] = proj(side === 'L' ? 212 : 188, HOME[1] - 1);
  const key = keyRuns.tying && keyRuns.tying.base === 'bat' ? 'Tying run' : keyRuns.ahead && keyRuns.ahead.base === 'bat' ? keyRuns.ahead.label : '';
  s += `<g class="batter"><ellipse cx="${px.toFixed(1)}" cy="${(py + 6).toFixed(1)}" rx="8" ry="2.6" fill="#000" opacity=".5"/>
    <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7.2" fill="${bColor}" stroke="${key ? 'var(--accent)' : '#fff'}" stroke-width="${key ? 2.6 : 1.8}"/>
    <text x="${(side === 'L' ? px + 12 : px - 12).toFixed(1)}" y="${(py + 3.5).toFixed(1)}" text-anchor="${side === 'L' ? 'start' : 'end'}" font-size="9.6" font-weight="700" fill="var(--chalk)" font-family="var(--font-body)" paint-order="stroke" stroke="#000" stroke-opacity=".8" stroke-width="3">${esc(batter.l || batter.n)}${key ? ` · ${esc(key.toLowerCase())}` : ''}</text></g>`;
  s += `</svg>`;
  return s;
}

// Bursts over the stands and flashes in the crowd, for a home run.
function fireworks() {
  const colors = ['#fff1cf', '#ffd27a', '#ff8a6a', '#9fd0ff', '#ffffff'];
  let out = '<g class="fireworks" aria-hidden="true">';
  for (let i = 0; i < 6; i++) {
    const cx = 60 + i * 56 + (i % 2) * 14, cy = 26 + (i % 3) * 16;
    const c = colors[i % colors.length];
    const rays = Array.from({ length: 12 }, (_, k) => {
      const a = (k / 12) * Math.PI * 2;
      return `<line x1="${cx}" y1="${cy}" x2="${(cx + 22 * Math.cos(a)).toFixed(1)}" y2="${(cy + 22 * Math.sin(a)).toFixed(1)}"/>`;
    }).join('');
    out += `<g class="spark-fx" style="animation-delay:${(0.35 + i * 0.22).toFixed(2)}s" stroke="${c}" stroke-width="1.6" stroke-linecap="round">${rays}</g>`;
  }
  for (let i = 0; i < 26; i++) {
    const x = 10 + ((i * 53) % 380), y = 8 + ((i * 29) % 70);
    out += `<circle class="flash-fx" cx="${x}" cy="${y}" r="1.4" fill="#fff" style="animation-delay:${((i * 0.37) % 1.6).toFixed(2)}s"/>`;
  }
  return out + '</g>';
}

// The pitch on its way: a ball from the mound to the plate, drawn over the field.
export function pitchFlight(svg, ms) {
  if (!svg || reduceMotion()) return;
  const [mx, my] = proj(200, 266), [px, py] = proj(200, 334);
  const ns = 'http://www.w3.org/2000/svg';
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('r', '2.8'); c.setAttribute('fill', '#fff'); c.setAttribute('cx', mx); c.setAttribute('cy', my);
  for (const [attr, from, to] of [['cx', mx, px], ['cy', my, py], ['r', 2.2, 3.6]]) {
    const an = document.createElementNS(ns, 'animate');
    an.setAttribute('attributeName', attr); an.setAttribute('from', from); an.setAttribute('to', to);
    an.setAttribute('dur', `${Math.max(0.12, ms / 1000)}s`); an.setAttribute('begin', 'indefinite'); an.setAttribute('fill', 'freeze');
    c.appendChild(an);
  }
  svg.appendChild(c);
  c.querySelectorAll('animate').forEach((an) => { try { an.beginElement(); } catch { /* old browsers: the ball just sits */ } });
  setTimeout(() => c.remove(), ms + 400);
}

function describe(g) {
  const occ = ['first', 'second', 'third'].filter((_, i) => g.bases[i]);
  return `${g.outs} out, ${occ.length ? 'runners on ' + occ.join(' and ') : 'bases empty'}`;
}
