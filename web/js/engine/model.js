// Player ratings -> plate appearance probabilities.
// Batter and pitcher season rates are combined with the odds-ratio method
// against that season's league, then adjusted for handedness, fatigue and how
// many times the batter has seen this pitcher today.

export const RATE = ['K', 'BB', 'HBP', 'HR', 'B1', 'B2', 'B3'];
export const OUTCOMES = ['K', 'BB', 'HBP', 'HR', 'B1', 'B2', 'B3', 'OUT'];
const LG_KEYS = ['k', 'bb', 'hbp', 'hr', 'b1', 'b2', 'b3'];

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Platoon multipliers relative to a hitter's season line (which is already a mix
// of mostly right-handed pitching), in RATE order.
const PLATOON = {
  'L-L': [1.13, 0.88, 1.2, 0.76, 0.94, 0.91, 0.9],
  'L-R': [0.955, 1.03, 0.95, 1.07, 1.02, 1.03, 1.03],
  'R-R': [1.035, 0.97, 1.0, 0.95, 0.985, 0.975, 0.98],
  'R-L': [0.92, 1.07, 1.0, 1.11, 1.03, 1.05, 1.04],
};

export function battingSide(bats, throws) {
  if (bats === 'B') return throws === 'L' ? 'R' : 'L';
  return bats === 'L' ? 'L' : 'R';
}

function oddsRatio(b, p, l) {
  b = clamp(b, 1e-4, 0.95); p = clamp(p, 1e-4, 0.95); l = clamp(l, 1e-4, 0.95);
  const o = (b / (1 - b)) * (p / (1 - p)) / (l / (1 - l));
  return o / (1 + o);
}

// Fatigue 0 (fresh) .. 1 (spent) for a pitcher given today's pitch count.
export function fatigue(pitcher, pitches, energy, cold) {
  const pr = pitcher.p;
  const stam = pr ? pr.stam : 25;
  const starter = pr && pr.role === 'SP';
  const cap = stam * (starter ? 1.15 : 1.55) * (0.45 + 0.55 * clamp(energy, 0, 1));
  let t = (pitches - 0.7 * cap) / (0.45 * cap);
  t = Math.max(0, t) + (1 - clamp(energy, 0, 1)) * 0.35;
  if (cold) t += 0.3;
  return clamp(t, 0, 1);
}

// Plate appearance target distribution for a matchup.
// ctx: { tired 0..1, tto (prior times faced today), lg (season league) }
export function paTarget(batter, pitcher, ctx) {
  const lg = ctx.lg.all;
  const b = batter.h;
  const p = pitcher.p ? pitcher.p.r : LG_KEYS.map((k) => lg[k]);
  const side = battingSide(batter.b, pitcher.t);
  const plat = PLATOON[side + '-' + (pitcher.t === 'L' ? 'L' : 'R')];
  const sw = batter.b === 'B' ? 0.6 : 1;
  const out = {};
  let sum = 0;
  RATE.forEach((key, i) => {
    let v = oddsRatio(b[i], p[i], lg[LG_KEYS[i]]);
    v *= 1 + (plat[i] - 1) * sw;
    out[key] = v;
  });
  const t = ctx.tired || 0;
  if (t > 0) {
    out.K *= 1 - 0.3 * t;
    out.BB *= 1 + 0.45 * t;
    out.HR *= 1 + 0.55 * t;
    out.B1 *= 1 + 0.2 * t;
    out.B2 *= 1 + 0.25 * t;
    out.B3 *= 1 + 0.2 * t;
  }
  const tto = ctx.tto || 0;
  if (tto >= 2) {
    const x = tto - 1;
    out.K *= 1 - 0.03 * x;
    out.HR *= 1 + 0.06 * x;
    out.B1 *= 1 + 0.03 * x;
    out.B2 *= 1 + 0.04 * x;
  }
  for (const k of RATE) sum += out[k];
  if (sum > 0.78) for (const k of RATE) out[k] *= 0.78 / sum;
  sum = RATE.reduce((s, k) => s + out[k], 0);
  out.OUT = 1 - sum;
  return out;
}

// Scouting grades (20-80) for display.
export function batterGrades(batter, lg) {
  const L = lg.pos;
  const [k, bb, , hr, b1, b2, b3] = batter.h;
  const hits = b1 + b2 + b3 + hr;
  const contact = clamp(Math.round(50 + 34 * (L.k / Math.max(0.02, k) - 1) * 0.6 + 8 * (hits / (L.b1 + L.b2 + L.b3 + L.hr) - 1) * 2), 20, 80);
  const iso = (b2 + 2 * b3 + 3 * hr) / Math.max(0.05, 1 - k - bb);
  const liso = (L.b2 + 2 * L.b3 + 3 * L.hr) / (1 - L.k - L.bb);
  const power = clamp(Math.round(50 + 30 * (iso / liso - 1)), 20, 80);
  const eye = clamp(Math.round(50 + 26 * (bb / L.bb - 1) - 10 * (k / L.k - 1)), 20, 80);
  return { contact, power, eye, speed: batter.spd };
}

export function eyeRating(batter, lg) {
  const L = lg.pos;
  return clamp(50 + 26 * (batter.h[1] / L.bb - 1) - 10 * (batter.h[0] / L.k - 1), 20, 80);
}
