// Exact win probability for the 9th inning and later.
//
// For the batting team, a Markov chain over (outs, bases, lineup slot) gives
// the distribution of runs still to score this half inning. Each batter's plate
// appearance distribution comes from the matchup model; advancement comes from
// the same batted-ball code used in live play, with average runners. The next
// half inning and extra innings follow from the same tables.

import { paTarget } from './model.js';
import { fairBallBranches, autoSend, ALIGN_DEFAULT } from './bip.js';

export const MAXR = 12;
export const TYPES = ['K', 'BB', 'HBP', 'HR', 'B3', 'B2', 'B1', 'OUT'];
const AVG = { spd: 50 };

export const maskOf = (bases) => (bases[0] ? 1 : 0) | (bases[1] ? 2 : 0) | (bases[2] ? 4 : 0);
const anonBases = (m) => [m & 1 ? AVG : null, m & 2 ? AVG : null, m & 4 ? AVG : null];

function forced(mask) {
  // walk / hit batsman: forced runners move up
  let runs = 0, m = mask;
  if (m & 1) {
    if (m & 2) {
      if (m & 4) runs = 1;
      m = 7;
    } else m |= 2;
  }
  m |= 1;
  return { mask: m, runs };
}

// Aggregate branches into [p, outsAfter, mask, runs]
function aggregate(outs, branches) {
  const acc = new Map();
  for (const br of branches) {
    const o = Math.min(3, outs + br.outs);
    const m = o >= 3 ? 0 : maskOf(br.bases);
    const r = br.scored.length;
    const key = o * 1000 + m * 100 + r;
    acc.set(key, (acc.get(key) || 0) + br.p);
  }
  const out = [];
  for (const [key, p] of acc) out.push([p, Math.floor(key / 1000), Math.floor((key % 1000) / 100), key % 100]);
  return out;
}

// A run can't score on a play whose third out is a force or a double play.
export function inningEndFix(outs, br) {
  if (outs + br.outs >= 3 && br.note && /double play|force|ground/.test(br.note)) return { ...br, scored: [] };
  return br;
}

// Transition tables for anonymous runners: TR[outs][mask][type] -> [[p,o,m,r]...]
const TR_CACHE = new Map();
export function transitions(opts = {}) {
  const key = JSON.stringify([Math.round((opts.roe || 0.014) * 1000), opts.align || null, opts.def || null]);
  if (TR_CACHE.has(key)) return TR_CACHE.get(key);
  const ctx = { batSide: 'R', align: opts.align || ALIGN_DEFAULT, def: opts.def || null, arms: opts.arms || null, roe: opts.roe || 0.014 };
  const policy = (kind, runner, ps) => autoSend(ps, 0, kind, ctx);
  const TR = [];
  for (let o = 0; o < 3; o++) {
    TR.push([]);
    for (let m = 0; m < 8; m++) {
      const row = [];
      for (const t of TYPES) {
        if (t === 'K') row.push([[1, o + 1, o + 1 >= 3 ? 0 : m, 0]]);
        else if (t === 'BB' || t === 'HBP') {
          const f = forced(m);
          row.push([[1, o, f.mask, f.runs]]);
        } else {
          const brs = fairBallBranches(t, ctx, o, anonBases(m), AVG,
            (kind, runner, ps) => autoSend(ps, o, kind, ctx)).map((b) => inningEndFix(o, b));
          row.push(aggregate(o, brs));
        }
      }
      TR[o].push(row);
    }
  }
  // wild pitches, passed balls and steals move runners up between pitches
  const a = opts.adv === undefined ? 0.015 : opts.adv;
  if (a > 0) {
    const base = TR.map((row) => row.map((cell) => cell.map((list) => list.slice())));
    for (let o = 0; o < 3; o++) {
      for (let m = 1; m < 8; m++) {
        const m2 = (m << 1) & 7, extra = m & 4 ? 1 : 0;
        for (let ti = 0; ti < TYPES.length; ti++) {
          const merged = new Map();
          const put = (p, o2, mm, r) => {
            const k = o2 * 1000 + mm * 100 + r;
            merged.set(k, (merged.get(k) || 0) + p);
          };
          for (const [p, o2, mm, r] of base[o][m][ti]) put(p * (1 - a), o2, mm, r);
          for (const [p, o2, mm, r] of base[o][m2][ti]) put(p * a, o2, mm, Math.min(MAXR - 1, r + extra));
          TR[o][m][ti] = [...merged].map(([k, p]) => [p, Math.floor(k / 1000), Math.floor((k % 1000) / 100), k % 100]);
        }
      }
    }
  }
  TR_CACHE.set(key, TR);
  return TR;
}

const idx = (o, m, s) => ((o * 8 + m) * 9 + s) * MAXR;

// Run-distribution table for one batting team against one pitcher.
// dists[slot] = {K,BB,...,OUT}; returns Float64Array with R(o,m,s)[r]
export function halfTable(dists, TR) {
  const R = new Float64Array(3 * 8 * 9 * MAXR);
  // start: everything scores zero more runs
  for (let i = 0; i < 3 * 8 * 9; i++) R[i * MAXR] = 1;
  const tmp = new Float64Array(MAXR);
  for (let sweep = 0; sweep < 7; sweep++) {
    for (let o = 2; o >= 0; o--) {
      for (let m = 0; m < 8; m++) {
        for (let s = 0; s < 9; s++) {
          tmp.fill(0);
          const d = dists[s];
          const ns = (s + 1) % 9;
          for (let ti = 0; ti < TYPES.length; ti++) {
            const pt = d[TYPES[ti]];
            if (!pt) continue;
            for (const [p, o2, m2, r] of TR[o][m][ti]) {
              const w = pt * p;
              if (o2 >= 3) { tmp[Math.min(r, MAXR - 1)] += w; continue; }
              const base = idx(o2, m2, ns);
              for (let k = 0; k + r < MAXR; k++) tmp[k + r] += w * R[base + k];
              // overflow mass lumps into the last bucket
              let over = 0;
              for (let k = Math.max(0, MAXR - r); k < MAXR; k++) over += R[base + k];
              tmp[MAXR - 1] += w * over * (r > 0 ? 1 : 0);
            }
          }
          const base = idx(o, m, s);
          for (let k = 0; k < MAXR; k++) R[base + k] = tmp[k];
        }
      }
    }
  }
  return R;
}

export function runDist(R, outs, mask, slot) {
  const b = idx(outs, mask, slot % 9);
  return R.subarray(b, b + MAXR);
}

const tailGt = (d, k) => { let s = 0; for (let i = k + 1; i < d.length; i++) s += d[i]; return k < 0 ? 1 : s; };
const at = (d, k) => (k >= 0 && k < d.length ? d[k] : 0);

// Home win probability in extra innings, tied, start of an inning.
export function extraTied(distV, distH) {
  let A = 0, B = 0;
  for (let r = 0; r < MAXR; r++) {
    A += distV[r] * tailGt(distH, r);
    B += distV[r] * distH[r];
  }
  return A / Math.max(1e-9, 1 - B);
}

// Average fresh-inning run distribution over lineup slots.
export function avgFresh(R, mask = 0) {
  const out = new Float64Array(MAXR);
  for (let s = 0; s < 9; s++) {
    const d = runDist(R, 0, mask, s);
    for (let k = 0; k < MAXR; k++) out[k] += d[k] / 9;
  }
  return out;
}

// Home WP given the distribution of runs the batting team will still score
// this half (cur), the score difference before those runs, and the next half's
// fresh distribution for the home team (when the visitors are batting).
export function homeWP(half, diff, cur, nextHome, X) {
  if (half === 0) {
    let wp = 0;
    for (let r = 0; r < MAXR; r++) {
      const p = cur[r];
      if (!p) continue;
      const d = diff - r;
      if (d > 0) wp += p; // home leads after the top: game over
      else wp += p * (tailGt(nextHome, -d) + at(nextHome, -d) * X);
    }
    return wp;
  }
  if (diff > 0) return 1;
  return tailGt(cur, -diff) + at(cur, -diff) * X;
}

// Distribution for the rest of the half after one step expressed as branches:
// [{p, outs, mask, runs, slotNext, sameBatter, count}] combined with the table.
// curBatterDist(count) supplies the current batter's distribution for
// branches where he is still at the plate.
export function restOfHalf(R, TR, branches, curBatterDist, slot) {
  const out = new Float64Array(MAXR);
  for (const br of branches) {
    if (br.p <= 0) continue;
    if (br.outs >= 3) { out[Math.min(br.runs, MAXR - 1)] += br.p; continue; }
    let d;
    if (br.sameBatter) {
      d = stepFromBatter(R, TR, br.outs, br.mask, slot, curBatterDist(br.count));
    } else d = runDist(R, br.outs, br.mask, (slot + 1) % 9);
    for (let k = 0; k < MAXR; k++) {
      const t = Math.min(MAXR - 1, k + br.runs);
      out[t] += br.p * d[k];
    }
  }
  return out;
}

// Run distribution when a specific batter (with his own PA distribution) is up.
export function stepFromBatter(R, TR, outs, mask, slot, dist) {
  const out = new Float64Array(MAXR);
  const ns = (slot + 1) % 9;
  for (let ti = 0; ti < TYPES.length; ti++) {
    const pt = dist[TYPES[ti]];
    if (!pt) continue;
    for (const [p, o2, m2, r] of TR[outs][mask][ti]) {
      const w = pt * p;
      if (o2 >= 3) { out[Math.min(r, MAXR - 1)] += w; continue; }
      const d = runDist(R, o2, m2, ns);
      for (let k = 0; k < MAXR; k++) out[Math.min(MAXR - 1, k + r)] += w * d[k];
    }
  }
  return out;
}

// Plate appearance distributions for a lineup against a pitcher.
export function lineupDists(batters, pitcher, lg, tired) {
  return batters.map((b) => paTarget(b, pitcher, { lg, tired, tto: 0 }));
}
