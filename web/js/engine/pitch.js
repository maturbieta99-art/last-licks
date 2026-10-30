// Pitch-level model.
//
// The strike zone is a 5x5 grid of locations relative to the batter:
// h -2..2 (away..inside), v -2..2 (low/dirt..high). |h|<=1 and |v|<=1 is the zone.
// Each pitch: the pitcher aims (type + target), command scatters the actual spot,
// the batter swings or takes, contact, foul or fair, and fair balls get a damage
// factor that tilts the batted-ball outcome.
//
// For every matchup three knobs are solved so that the catcher's-call policy
// reproduces the odds-ratio plate appearance targets exactly:
//   W (whiff scale) -> strikeouts, Z (zone targeting) -> walks, H -> hit batters,
// plus correction factors on the batted-ball outcomes.

import { paTarget, eyeRating, battingSide } from './model.js';
import { hashString } from './rng.js';

export const PITCH_TYPES = {
  FF: { name: 'Four-seam fastball', short: 'Fastball', cls: 'F', whiff: 0.95 },
  SI: { name: 'Sinker', short: 'Sinker', cls: 'F', whiff: 0.85, gb: 1.3 },
  FC: { name: 'Cutter', short: 'Cutter', cls: 'F', whiff: 1.0, gb: 1.05 },
  SL: { name: 'Slider', short: 'Slider', cls: 'B', whiff: 1.14 },
  CU: { name: 'Curveball', short: 'Curve', cls: 'B', whiff: 1.08, gb: 1.1 },
  KC: { name: 'Knuckle curve', short: 'Knuckle curve', cls: 'B', whiff: 1.12, gb: 1.1 },
  CH: { name: 'Changeup', short: 'Changeup', cls: 'O', whiff: 1.08, gb: 1.15 },
  FS: { name: 'Splitter', short: 'Splitter', cls: 'O', whiff: 1.15, gb: 1.25 },
  SC: { name: 'Screwball', short: 'Screwball', cls: 'O', whiff: 1.08, gb: 1.1 },
  KN: { name: 'Knuckleball', short: 'Knuckleball', cls: 'K', whiff: 1.12 },
};

// cell index helpers: idx = (v + 2) * 5 + (h + 2)
export const cellIndex = (h, v) => (v + 2) * 5 + (h + 2);
export const cellH = (i) => (i % 5) - 2;
export const cellV = (i) => Math.floor(i / 5) - 2;
export const inZone = (i) => Math.abs(cellH(i)) <= 1 && Math.abs(cellV(i)) <= 1;

// cell classes: 0 heart, 1 edge, 2 corner, 3 chase, 4 chase-corner, 5 far
const CLS = new Array(25);
for (let i = 0; i < 25; i++) {
  const ah = Math.abs(cellH(i)), av = Math.abs(cellV(i));
  if (ah === 0 && av === 0) CLS[i] = 0;
  else if (ah <= 1 && av <= 1) CLS[i] = ah + av === 1 ? 1 : 2;
  else if (ah === 2 && av === 2) CLS[i] = 5;
  else if (ah === 2 && av === 0) CLS[i] = 3;
  else if (av === 2 && ah === 0) CLS[i] = 3;
  else CLS[i] = 4;
}
export const CELL_CLASS = CLS;
const SWING = [0.80, 0.68, 0.58, 0.37, 0.29, 0.11];
const CONTACT = [0.91, 0.87, 0.83, 0.68, 0.60, 0.44];
const FOUL = [0.36, 0.46, 0.52, 0.56, 0.60, 0.64];
const CALLED = [1.0, 0.95, 0.83, 0.13, 0.06, 0.01];
const DAMAGE = [1.45, 1.10, 0.85, 0.72, 0.62, 0.50];

// swing multipliers by count [zone, chase]
const COUNT_SWING = {
  '0-0': [0.82, 0.80], '1-0': [0.95, 0.90], '2-0': [0.90, 0.75], '3-0': [0.30, 0.12],
  '0-1': [1.00, 1.00], '1-1': [1.02, 1.00], '2-1': [1.05, 1.00], '3-1': [1.00, 0.80],
  '0-2': [1.15, 1.45], '1-2': [1.15, 1.40], '2-2': [1.15, 1.35], '3-2': [1.20, 1.25],
};
const COUNT_DAMAGE = { '2-0': 1.1, '3-0': 1.12, '3-1': 1.1, '2-1': 1.04, '0-2': 0.9, '1-2': 0.94 };
// catcher's call: share of pitches aimed in the zone, and fastball lean, by count
const ZONE_AIM = {
  '0-0': 0.60, '1-0': 0.66, '2-0': 0.75, '3-0': 0.86, '0-1': 0.52, '1-1': 0.57,
  '2-1': 0.64, '3-1': 0.75, '0-2': 0.30, '1-2': 0.38, '2-2': 0.48, '3-2': 0.66,
};
const FB_LEAN = {
  '0-0': 1.0, '1-0': 1.15, '2-0': 1.35, '3-0': 1.6, '0-1': 0.9, '1-1': 0.95,
  '2-1': 1.1, '3-1': 1.35, '0-2': 0.75, '1-2': 0.8, '2-2': 0.85, '3-2': 1.1,
};
export const COUNTS = [];
for (let b = 0; b <= 3; b++) for (let s = 0; s <= 2; s++) COUNTS.push(`${b}-${s}`);

// Outcome categories for a fair ball
export const BIP = ['HR', 'B3', 'B2', 'B1', 'OUT'];
const BIP_EXP = [2.0, 1.3, 1.3, 0.6, -0.45];

// ---------------------------------------------------------------- aim maps
function aimVectors(cls, twoStrikes) {
  const zone = new Float64Array(25), out = new Float64Array(25);
  for (let i = 0; i < 25; i++) {
    const h = cellH(i), v = cellV(i), c = CLS[i];
    if (c <= 2) {
      zone[i] = c === 0 ? 0.06 : c === 1 ? 0.11 : 0.125;
      if (cls !== 'F' && v === -1) zone[i] *= 1.35; // spin and changeups live low
      if (cls === 'F' && v === 1 && twoStrikes) zone[i] *= 1.3;
    } else {
      let w = c === 3 ? 0.11 : c === 4 ? 0.06 : 0.012;
      if (v < 0) w *= cls === 'F' ? 1.0 : 1.8;
      if (v > 0) w *= cls === 'F' ? (twoStrikes ? 2.0 : 1.0) : 0.35;
      if (h < 0) w *= 1.3; // away
      if (h > 0) w *= 0.7;
      out[i] = w;
    }
  }
  const norm = (a) => { let s = 0; for (const x of a) s += x; for (let i = 0; i < 25; i++) a[i] /= s; return a; };
  return { zone: norm(zone), out: norm(out) };
}
const AIM = {};
for (const cls of ['F', 'B', 'O', 'K']) AIM[cls] = [aimVectors(cls, false), aimVectors(cls, true)];

// scatter matrix for a command level: S[target*25 + actual]
const SCATTER_CACHE = new Map();
export function scatterMatrix(command) {
  const key = Math.round(command * 50);
  if (SCATTER_CACHE.has(key)) return SCATTER_CACHE.get(key);
  const c = key / 50;
  const S = new Float64Array(625);
  for (let t = 0; t < 25; t++) {
    const th = cellH(t), tv = cellV(t);
    S[t * 25 + t] += c;
    const miss = 1 - c;
    const ring1 = [], ring2 = [];
    for (let dv = -2; dv <= 2; dv++) {
      for (let dh = -2; dh <= 2; dh++) {
        const d = Math.max(Math.abs(dh), Math.abs(dv));
        if (d === 0) continue;
        const nh = Math.max(-2, Math.min(2, th + dh)), nv = Math.max(-2, Math.min(2, tv + dv));
        const w = d === 1 ? (dh === 0 || dv === 0 ? 1.5 : 1) : 1;
        (d === 1 ? ring1 : ring2).push([cellIndex(nh, nv), w]);
      }
    }
    const t1 = ring1.reduce((s, x) => s + x[1], 0), t2 = ring2.reduce((s, x) => s + x[1], 0);
    for (const [a, w] of ring1) S[t * 25 + a] += miss * 0.88 * w / t1;
    for (const [a, w] of ring2) S[t * 25 + a] += miss * 0.12 * w / t2;
  }
  SCATTER_CACHE.set(key, S);
  return S;
}

export function commandOf(pitcher, tired, typeKey) {
  const ctl = pitcher.p ? pitcher.p.ctl : 40;
  let c = 0.47 + 0.0055 * (ctl - 50) - 0.12 * tired;
  if (typeKey === 'KN') c -= 0.08;
  return Math.max(0.22, Math.min(0.64, c));
}

// Batter zone map: damage multipliers per cell, estimated from power and handedness
export function zoneMap(batter) {
  const [seedA, seedB] = hashString(batter.n + batter.b);
  const lowBall = ((seedA % 1000) / 1000 - 0.5) * 0.24; // + likes low pitches
  const pullPower = Math.min(0.22, Math.max(0, (batter.h[3] - 0.022) * 6));
  const away = (((seedB >>> 3) % 1000) / 1000 - 0.5) * 0.16;
  const m = new Float64Array(25);
  let s = 0, n = 0;
  for (let i = 0; i < 25; i++) {
    const h = cellH(i), v = cellV(i);
    let x = 1;
    x += lowBall * (v < 0 ? 1 : v > 0 ? -1 : 0);
    x += pullPower * (h > 0 ? 1 : h < 0 ? -0.6 : 0.3);
    x += away * (h < 0 ? 1 : 0);
    m[i] = Math.max(0.75, Math.min(1.3, x));
    if (inZone(i)) { s += m[i]; n++; }
  }
  for (let i = 0; i < 25; i++) m[i] /= s / n;
  return m;
}

// ---------------------------------------------------------------- approach
// approach: 'normal' | 'take' | 'sitFB' | 'protect' | 'aggressive'
function approachMods(approach, cls) {
  switch (approach) {
    case 'take': return { zs: 0, cs: 0, wh: 1, dmg: 1, foul: 0 };
    case 'sitFB':
      return cls === 'F' ? { zs: 1.15, cs: 1.0, wh: 0.9, dmg: 1.2, foul: 0 }
        : { zs: 0.6, cs: 0.55, wh: 1.4, dmg: 0.85, foul: 0 };
    case 'protect': return { zs: 1.12, cs: 1.25, wh: 0.72, dmg: 0.8, foul: 0.08 };
    case 'aggressive': return { zs: 1.12, cs: 1.15, wh: 1.15, dmg: 1.1, foul: 0 };
    default: return { zs: 1, cs: 1, wh: 1, dmg: 1, foul: 0 };
  }
}

// ---------------------------------------------------------------- matchup
// Builds everything needed to play and evaluate one batter vs one pitcher.
export function buildMatchup(batter, pitcher, ctx) {
  const M = buildCalibrated(batter, pitcher, ctx);
  if (ctx.basesLoaded) {
    // with nowhere to put him, the pitcher attacks the zone
    M.zCtx = 0.07;
    M.V = M.solve();
    M.cache = {};
  }
  return M;
}

function buildCalibrated(batter, pitcher, ctx) {
  const target = paTarget(batter, pitcher, ctx);
  const lg = ctx.lg;
  const eye = eyeRating(batter, lg);
  const chaseMult = 1 + 0.012 * (50 - eye);
  const zoneSwingMult = 1 + 0.003 * (50 - eye);
  const batWhiff = Math.pow(Math.max(0.03, batter.h[0]) / Math.max(0.03, lg.pos.k), 0.6);
  const tired = ctx.tired || 0;
  const ars = (pitcher.p && pitcher.p.ars && pitcher.p.ars.length)
    ? pitcher.p.ars : [['FF', 60, 45], ['SL', 25, 42], ['CH', 15, 40]];
  const types = ars.map(([t, use, q]) => ({
    key: t, use, q: Math.max(20, q - 10 * tired), cls: PITCH_TYPES[t] ? PITCH_TYPES[t].cls : 'F',
    whiff: PITCH_TYPES[t] ? PITCH_TYPES[t].whiff : 1,
  }));
  const zmap = zoneMap(batter);
  const bipT = {};
  const inPlay = 1 - target.K - target.BB - target.HBP;
  for (const o of BIP) bipT[o] = (o === 'OUT' ? target.OUT : target[o]) / inPlay;

  const M = {
    batter, pitcher, ctx, target, types, zmap, bipT, tired,
    W: 1, Z: 0, H: 0.03, corr: [1, 1, 1, 1, 1], zCtx: 0,
    scatter: types.map((t) => scatterMatrix(commandOf(pitcher, tired, t.key))),
    side: battingSide(batter.b, pitcher.t),
  };

  // per-pitch outcome probabilities at an actual cell
  M.pitchProbs = function (cell, ti, count, approach, seq) {
    const t = types[ti];
    const c = CLS[cell];
    const zone = c <= 2;
    const [zs, cs] = COUNT_SWING[count];
    const am = approachMods(approach, t.cls);
    let swing;
    if (approach === 'take') swing = 0;
    else {
      swing = SWING[c] * (zone ? zs * zoneSwingMult * am.zs : cs * chaseMult * am.cs);
      // contact hitters (low whiff knob) protect the plate harder with two strikes
      if (zone && count.endsWith('2')) swing *= 1 + Math.max(0, 0.6 - M.W) * 0.45;
      const v = cellV(cell), h = cellH(cell);
      if (!zone && t.cls !== 'F' && (v < 0 || h < 0)) swing *= 1.25;
      if (!zone && t.cls === 'F' && v > 0) swing *= 1.2;
      swing = Math.min(0.97, swing);
    }
    let whiff = (1 - CONTACT[c]) * M.W * batWhiff * t.whiff * (1 + 0.011 * (t.q - 50)) * am.wh;
    let dmg = DAMAGE[c] * zmap[cell] * (1 - 0.008 * (t.q - 50)) * am.dmg * (COUNT_DAMAGE[count] || 1);
    if (seq && seq.length >= 2) {
      const a = seq[seq.length - 1], b = seq[seq.length - 2];
      if (a.ti === ti && b.ti === ti) { whiff *= 0.8; dmg *= 1.1; }
      if (a.ti === ti && a.cell === cell) { whiff *= 0.85; dmg *= 1.12; }
    }
    const contact = Math.max(0.2, Math.min(0.97, 1 - whiff));
    let foul = FOUL[c] + (count.endsWith('2') ? 0.06 : 0) + am.foul;
    foul = Math.min(0.85, foul);
    const called = count.endsWith('2') ? CALLED[c] * Math.min(1, 0.5 + 0.8 * M.W) : CALLED[c];
    const hbp = cellH(cell) === 2 ? M.H : 0;
    const take = 1 - swing;
    return {
      ball: take * (1 - called) * (1 - hbp), cstr: take * called, hbp: take * (1 - called) * hbp,
      sstr: swing * (1 - contact), foul: swing * contact * foul,
      inplay: swing * contact * (1 - foul), dmg, swing, contact,
    };
  };

  // batted-ball outcome distribution for a damage factor
  M.bipDist = function (dmg) {
    const out = new Float64Array(5);
    let s = 0;
    for (let i = 0; i < 5; i++) {
      out[i] = bipT[BIP[i]] * Math.pow(dmg, BIP_EXP[i]) * M.corr[i];
      s += out[i];
    }
    for (let i = 0; i < 5; i++) out[i] /= s;
    return out;
  };

  // catcher's call distribution over (type, actual cell) at a count
  M.autoActual = function (count) {
    const lean = FB_LEAN[count];
    let tot = 0;
    const w = types.map((t) => {
      const x = t.use * (t.cls === 'F' ? lean : 1 / Math.sqrt(lean));
      tot += x;
      return x;
    });
    const zshare = Math.max(0.05, Math.min(0.95, ZONE_AIM[count] + M.Z + M.zCtx));
    const two = count.endsWith('2') ? 1 : 0;
    return types.map((t, ti) => {
      const aim = AIM[t.cls][two];
      const S = M.scatter[ti];
      const actual = new Float64Array(25);
      for (let tgt = 0; tgt < 25; tgt++) {
        const p = zshare * aim.zone[tgt] + (1 - zshare) * aim.out[tgt];
        if (p === 0) continue;
        for (let a = 0; a < 25; a++) actual[a] += p * S[tgt * 25 + a];
      }
      return { p: w[ti] / tot, actual };
    });
  };

  // aggregate per-count pitch outcome probabilities under the catcher's call
  M.countTable = function (approachFn) {
    const table = {};
    for (const count of COUNTS) {
      const approach = approachFn ? approachFn(count) : 'normal';
      const row = { ball: 0, cstr: 0, sstr: 0, foul: 0, inplay: 0, hbp: 0, bip: new Float64Array(5) };
      for (const [ti, { p, actual }] of M.autoActual(count).entries()) {
        for (let cell = 0; cell < 25; cell++) {
          const w = p * actual[cell];
          if (w < 1e-9) continue;
          const r = M.pitchProbs(cell, ti, count, approach, null);
          row.ball += w * r.ball; row.cstr += w * r.cstr; row.sstr += w * r.sstr;
          row.foul += w * r.foul; row.hbp += w * r.hbp;
          const ip = w * r.inplay;
          row.inplay += ip;
          if (ip > 0) {
            const d = M.bipDist(r.dmg);
            for (let i = 0; i < 5; i++) row.bip[i] += ip * d[i];
          }
        }
      }
      table[count] = row;
    }
    return table;
  };

  // exact plate appearance outcome distribution from every count
  M.solve = function (approachFn) {
    const table = M.countTable(approachFn);
    const V = {};
    // vector: [K, BB, HBP, HR, B3, B2, B1, OUT, pitches]
    const vec = () => new Float64Array(9);
    for (let b = 3; b >= 0; b--) {
      for (let s = 2; s >= 0; s--) {
        const r = table[`${b}-${s}`];
        const v = vec();
        const ballNext = b === 3 ? null : V[`${b + 1}-${s}`];
        const strNext = s === 2 ? null : V[`${b}-${s + 1}`];
        const add = (src, w) => { for (let i = 0; i < 9; i++) v[i] += w * src[i]; };
        if (ballNext) add(ballNext, r.ball); else v[1] += r.ball;
        const str = r.cstr + r.sstr + (s < 2 ? r.foul : 0);
        if (strNext) add(strNext, str); else v[0] += r.cstr + r.sstr;
        v[2] += r.hbp;
        v[3] += r.bip[0]; v[4] += r.bip[1]; v[5] += r.bip[2]; v[6] += r.bip[3]; v[7] += r.bip[4];
        v[8] += 1;
        if (s === 2) {
          const stay = r.foul;
          for (let i = 0; i < 9; i++) v[i] /= 1 - stay;
        }
        V[`${b}-${s}`] = v;
      }
    }
    return V;
  };

  // solve the knobs
  for (let iter = 0; iter < 7; iter++) {
    const v = M.solve()['0-0'];
    const k = v[0], bb = v[1], hbp = v[2];
    const ip = Math.max(1e-6, v[3] + v[4] + v[5] + v[6] + v[7]);
    const sim = [v[3] / ip, v[4] / ip, v[5] / ip, v[6] / ip, v[7] / ip];
    const dk = target.K - k, dbb = target.BB - bb;
    M.W *= Math.pow(Math.max(0.01, target.K) / Math.max(0.01, k), 0.9);
    M.W = Math.max(0.04, Math.min(4, M.W));
    M.Z = Math.max(-0.35, Math.min(0.35, M.Z + (bb - target.BB) * 2.2));
    M.H = Math.max(0, Math.min(0.5, M.H * (target.HBP + 1e-4) / (hbp + 1e-4)));
    BIP.forEach((o, i) => { M.corr[i] *= bipT[o] / Math.max(1e-6, sim[i]); });
    if (Math.abs(dk) < 0.0015 && Math.abs(dbb) < 0.0015 && iter >= 2) break;
  }
  M.V = M.solve();
  M.cache = {};
  return M;
}

// distribution as an object from a solved count vector
export function distFromVector(v) {
  return { K: v[0], BB: v[1], HBP: v[2], HR: v[3], B3: v[4], B2: v[5], B1: v[6], OUT: v[7], pitches: v[8] };
}

// PA distribution from a count, optionally with a different approach policy
export function paDist(M, b, s, approachKey) {
  if (!approachKey || approachKey === 'normal') return distFromVector(M.V[`${b}-${s}`]);
  const key = approachKey;
  if (!M.cache[key]) {
    const fn = approachKey === 'takeUntilStrike'
      ? (count) => (count.endsWith('-0') ? 'take' : 'normal')
      : () => approachKey;
    M.cache[key] = M.solve(fn);
  }
  return distFromVector(M.cache[key][`${b}-${s}`]);
}

// ---------------------------------------------------------------- live play
// Choose a pitch the way the catcher would.
export function catcherCall(M, count, rng) {
  const lean = FB_LEAN[count];
  const w = M.types.map((t) => t.use * (t.cls === 'F' ? lean : 1 / Math.sqrt(lean)));
  const ti = rng.pickIndex(w);
  const t = M.types[ti];
  const zshare = Math.max(0.05, Math.min(0.95, ZONE_AIM[count] + M.Z + (M.zCtx || 0)));
  const aim = AIM[t.cls][count.endsWith('2') ? 1 : 0];
  const inZ = rng.chance(zshare);
  const vecw = Array.from(inZ ? aim.zone : aim.out);
  const target = rng.pickIndex(vecw);
  return { ti, target };
}

// Where the pitch actually ends up.
export function deliver(M, ti, target, rng, extraWild = 0) {
  const S = M.scatter[ti];
  const w = [];
  for (let a = 0; a < 25; a++) w.push(S[target * 25 + a]);
  if (extraWild > 0) {
    // slide step / fatigue: blend toward a wider miss
    for (let a = 0; a < 25; a++) w[a] = w[a] * (1 - extraWild) + extraWild / 25;
  }
  return rng.pickIndex(w);
}

// Resolve one pitch at an actual cell. Returns what happened at the plate.
export function resolveAtPlate(M, cell, ti, count, approach, seq, rng) {
  const r = M.pitchProbs(cell, ti, count, approach, seq);
  const x = rng.next();
  let acc = r.ball;
  if (x < acc) return { kind: 'ball', cell, ti, r };
  acc += r.cstr;
  if (x < acc) return { kind: 'called', cell, ti, r };
  acc += r.hbp;
  if (x < acc) return { kind: 'hbp', cell, ti, r };
  acc += r.sstr;
  if (x < acc) return { kind: 'swinging', cell, ti, r };
  acc += r.foul;
  if (x < acc) return { kind: 'foul', cell, ti, r };
  const d = M.bipDist(r.dmg);
  const oi = rng.pickIndex(Array.from(d));
  return { kind: 'inplay', cell, ti, r, result: BIP[oi], dmg: r.dmg };
}

// Contact on a bunt attempt at a cell (no full swing).
export function buntContact(M, cell, skill) {
  const c = CLS[cell];
  const base = [0.92, 0.88, 0.8, 0.55, 0.42, 0.2][c];
  return Math.max(0.1, Math.min(0.97, base + 0.006 * (skill - 50)));
}
