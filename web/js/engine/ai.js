// The opposing manager.
//
// First it follows the real manager: when the game reaches the same situation
// as the real play-by-play (inning, half, outs, runners, score, batter), it
// makes the same substitutions and intentional walks. Otherwise it weighs its
// options with the win-probability model, with era-flavored tendencies.

import { maskOf } from './wp.js';
import { evalDefense, evalOffense, projectedPitcher, tacticOptions, forSide } from './evaluate.js';
import { fatigue } from './model.js';

function eraTendency(season) {
  // how big a gain a manager of that era needed before making a move
  if (season < 1950) return { hook: 0.045, bunt: -0.012, steal: 0.004, ibb: 0.01 };
  if (season < 1980) return { hook: 0.03, bunt: -0.008, steal: 0.004, ibb: 0.008 };
  if (season < 2000) return { hook: 0.018, bunt: -0.004, steal: 0.005, ibb: 0.008 };
  return { hook: 0.012, bunt: 0.004, steal: 0.006, ibb: 0.01 };
}

function historyMatch(g) {
  const hist = g.sc.history;
  const pre = (i) => (i === 0 ? g.sc.score9 : hist[i - 1].s1);
  const slot = g.bat().slot;
  for (let i = g.histIdx || 0; i < hist.length; i++) {
    const h = hist[i];
    if (h.i !== g.inning || h.h !== g.half) continue;
    if (h.o0 !== g.outs || h.lp !== slot) continue;
    if (maskOf(h.r0) !== maskOf(g.bases)) continue;
    const s0 = h.s0 || pre(i);
    if (s0[0] !== g.score[0] || s0[1] !== g.score[1]) continue;
    return { h, i };
  }
  return null;
}

// Apply the real manager's moves for this side at a matching moment.
function mirror(g, side, match) {
  const { h, i } = match;
  if (g._mirrored && g._mirrored.has(i + ':' + side)) return false;
  g._mirrored = g._mirrored || new Set();
  g._mirrored.add(i + ':' + side);
  let did = false;
  const team = g.teams[side];
  for (const s of h.subs || []) {
    if (s.t !== side) continue;
    if (s.k === 'pitch' && side !== g.half && team.pen.includes(s.in)) {
      if (g.changePitcher(s.in, { side, force: !g.canChangePitcher(side).ok && !team.pitcher }).ok) did = true;
    } else if (s.k === 'ph' && side === g.half && team.bench.includes(s.in) && s.slot === team.slot && !g.paStarted) {
      if (g.pinchHit(s.in).ok) did = true;
    } else if (s.k === 'pr' && side === g.half && team.bench.includes(s.in)) {
      const base = g.bases.findIndex((r) => r && r.pid === s.out);
      if (base >= 0 && g.pinchRun(base + 1, s.in).ok) did = true;
    } else if (s.k === 'def' && side !== g.half && team.bench.includes(s.in) && s.slot !== undefined) {
      if (g.defSub(side, s.slot, s.in, s.pos).ok) did = true;
    } else if (s.k === 'pos' && side !== g.half && s.slot !== undefined) {
      g.movePos(side, s.slot, s.pos); did = true;
    }
  }
  if (side !== g.half && /^(IW|I)(\.|$)/.test(h.ev) && !g.paStarted) {
    g.ibb();
    did = true;
  }
  g.histIdx = Math.max(g.histIdx || 0, i);
  return did;
}

// Moves for an AI team at the start of a plate appearance. Returns the PA plan
// for the batting side ({ tactic }) or null.
export function aiPrePA(g, side) {
  if (g.over || g.pending) return null;
  const T = eraTendency(g.season);
  const match = historyMatch(g);
  const mirrored = match ? mirror(g, side, match) : false;
  if (g.over || g.pending) return null;
  if (side !== g.half) return aiDefense(g, side, T, mirrored);
  return aiOffense(g, side, T, mirrored);
}

function aiDefense(g, side, T, mirrored) {
  const ft = g.teams[side];
  // forced: no pitcher
  if (!ft.pitcher || ft.removed.has(ft.pitcher)) {
    const pp = projectedPitcher(g, ft);
    if (pp && pp.pid && ft.pen.includes(pp.pid)) g.changePitcher(pp.pid, { side, force: true });
    else if (ft.pen.length) g.changePitcher(ft.pen[0], { side, force: true });
    return null;
  }
  if (mirrored) { aiAlign(g, side); return null; }
  const can = g.canChangePitcher(side).ok;
  const base = forSide(evalDefense(g, { pid: ft.pitcher }).wp, side);
  let bestPid = null, bestWp = base;
  if (can && ft.pen.length) {
    const tired = g.pitcherTired(ft);
    const cands = ft.pen.slice().sort((a, b) => (ft.energy[b] ?? 1) - (ft.energy[a] ?? 1)).slice(0, 6);
    for (const pid of cands) {
      const wp = forSide(evalDefense(g, { pid }).wp, side);
      // starters lose more as they tire; managers pull them faster when they do
      const need = T.hook * (tired > 0.7 ? 0.4 : 1);
      if (wp > bestWp + need) { bestWp = wp; bestPid = pid; }
    }
  }
  if (bestPid) {
    if (ft.warming[bestPid] === undefined && g.rng.chance(0.5)) ft.warming[bestPid] = 1; // he was ready
    g.changePitcher(bestPid, { side });
  }
  // intentional walk
  if (!g.over && g.bases.filter(Boolean).length < 3) {
    const noIbb = forSide(evalDefense(g, { pid: ft.pitcher }).wp, side);
    const ibb = forSide(evalDefense(g, { pid: ft.pitcher, ibb: true }).wp, side);
    if (ibb > noIbb + T.ibb) { g.ibb(); return null; }
  }
  aiAlign(g, side);
  return null;
}

function aiAlign(g, side) {
  const ft = g.teams[side];
  const b = g.bases;
  const choices = [{ inf: 'normal', of: 'normal' }];
  if (b[2] && g.outs < 2) choices.push({ inf: 'in', of: 'normal' }, { inf: 'in', of: 'shallow' });
  if (b[0] && g.outs < 2) choices.push({ inf: 'dp', of: 'normal' });
  if (g.inning >= 9 && !b[1] && !b[2]) choices.push({ inf: 'lines', of: 'deep' });
  let bestA = choices[0], bestAWp = -1;
  for (const a of choices) {
    const wp = forSide(evalDefense(g, { pid: ft.pitcher, align: { ...ft.align, ...a } }).wp, side);
    if (wp > bestAWp + 0.002) { bestAWp = wp; bestA = a; }
  }
  g.setAlign(side, bestA);
}

function aiOffense(g, side, T, mirrored) {
  const bt = g.teams[side];
  let plan = { tactic: 'swing' };
  // pinch hitter
  if (!mirrored && !g.paStarted && bt.bench.length) {
    const base = forSide(evalOffense(g, { tactic: 'swing' }).wp, side);
    let best = null, bestWp = base + 0.008;
    for (const pid of bt.bench.slice(0, 8)) {
      const wp = forSide(evalOffense(g, { batter: pid, tactic: 'swing' }).wp, side);
      if (wp > bestWp) { bestWp = wp; best = pid; }
    }
    if (best) g.pinchHit(best);
  }
  // pinch runner for the tying or winning run
  const lead = g.bases[2] ? 3 : g.bases[1] ? 2 : g.bases[0] ? 1 : 0;
  if (lead && bt.bench.length) {
    const runner = g.bases[lead - 1];
    const fast = bt.bench.map((pid) => ({ pid, spd: g.P(pid).spd || 50 })).sort((a, b) => b.spd - a.spd)[0];
    if (fast && fast.spd >= (runner.spd || 50) + 12 && g.bigRun(runner)) g.pinchRun(lead, fast.pid);
  }
  // tactic for this plate appearance
  const opts = tacticOptions(g).filter((t) => t !== 'take' || g.count.b >= 2);
  let bestT = 'swing';
  let bestWp = forSide(evalOffense(g, { tactic: 'swing' }).wp, side);
  for (const t of opts) {
    if (t === 'swing') continue;
    const wp = forSide(evalOffense(g, { tactic: t }).wp, side);
    let need = 0.008;
    if (t === 'sac' || t === 'squeeze' || t === 'safety') need += T.bunt;
    if (t.startsWith('steal') || t === 'double') need = T.steal;
    if (wp > bestWp + need) { bestWp = wp; bestT = t; }
  }
  plan.tactic = bestT;
  return plan;
}

// Sign for this pitch for an AI batting team.
export function aiSign(g, plan) {
  const sign = {};
  const t = plan && plan.tactic;
  if (t && !plan.used) {
    if (t === 'sac' || t === 'squeeze' || t === 'safety' || t === 'drag') sign.bunt = t;
    else if (t === 'steal2') sign.steal = 2;
    else if (t === 'steal3') sign.steal = 3;
    else if (t === 'steal4') sign.steal = 4;
    else if (t === 'double') sign.steal = 'double';
    else if (t === 'hitrun') sign.hitRun = true;
    else if (t === 'take') sign.approach = 'take';
    plan.used = !!(sign.bunt || sign.steal || sign.hitRun);
  }
  if (!sign.bunt && !sign.steal && !sign.hitRun) {
    if (g.count.b === 3 && g.count.s === 0) sign.approach = 'take';
    else if (g.count.s === 2) sign.approach = 'normal';
  }
  return sign;
}

// Defensive extras for an AI fielding team on this pitch.
export function aiDefensePitch(g) {
  const d = {};
  const r1 = g.bases[0];
  if (r1 && !g.bases[1] && (r1.spd || 50) >= 68 && g.count.b < 2 && g.inning >= 8 && g.rng.chance(0.06)) d.pitchout = true;
  return d;
}
