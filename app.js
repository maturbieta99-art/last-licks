// Last Licks. Built from web/js by tools/build.mjs.
(function () {
"use strict";
const __m = {};
function __def(id, fn) { __m[id] = { fn, exports: null }; }
function __req(id) { const m = __m[id]; if (!m) throw new Error("missing module " + id); if (!m.exports) { m.exports = {}; m.fn(m.exports); } return m.exports; }
__def("engine/ai.js", function (exports) {
// The opposing manager.
//
// First it follows the real manager: when the game reaches the same situation
// as the real play-by-play (inning, half, outs, runners, score, batter), it
// makes the same substitutions and intentional walks. Otherwise it weighs its
// options with the win-probability model, with era-flavored tendencies.

const { maskOf } = __req("engine/wp.js");
const { evalDefense, evalOffense, projectedPitcher, tacticOptions, forSide, relieverPool } = __req("engine/evaluate.js");
const { fatigue } = __req("engine/model.js");

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
function aiPrePA(g, side) {
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
    const cands = relieverPool(g, ft).slice().sort((a, b) => (ft.energy[b] ?? 1) - (ft.energy[a] ?? 1)).slice(0, 6);
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
function aiSign(g, plan) {
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
function aiDefensePitch(g) {
  const d = {};
  const r1 = g.bases[0];
  if (r1 && !g.bases[1] && (r1.spd || 50) >= 68 && g.count.b < 2 && g.inning >= 8 && g.rng.chance(0.06)) d.pitchout = true;
  return d;
}

Object.assign(exports, { aiPrePA, aiSign, aiDefensePitch });
});
__def("engine/bip.js", function (exports) {
// Fair balls and baserunning.
//
// A fair ball resolves in three steps:
//   1. profile: batted-ball type (G ground, L liner, F fly, P pop), field and depth
//   2. conversions: alignment, fielder range and errors can turn hits into outs
//      or outs into hits
//   3. advancement: runners move, with send/hold calls on close plays
// Every step returns weighted branches, so the same code drives live play
// (sample one branch) and the win-probability model (sum over branches).

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Field positions: 1 P, 2 C, 3 1B, 4 2B, 5 3B, 6 SS, 7 LF, 8 CF, 9 RF
const MIRROR = { 3: 5, 5: 3, 4: 6, 6: 4, 7: 9, 9: 7, 1: 1, 2: 2, 8: 8 };

const ALIGN_DEFAULT = { inf: 'normal', of: 'normal', shift: false };

function bbMix(category, ctx) {
  let mix;
  switch (category) {
    case 'HR': mix = { F: 0.75, L: 0.25 }; break;
    case 'B3': mix = { F: 0.5, L: 0.5 }; break;
    case 'B2': mix = { L: 0.55, F: 0.35, G: 0.1 }; break;
    case 'B1': mix = { G: 0.38, L: 0.46, F: 0.16 }; break;
    default: mix = { G: 0.46, F: 0.27, L: 0.12, P: 0.15 };
  }
  if (category === 'OUT' || category === 'B1') {
    const gb = ctx.gbTilt || 1;
    mix = { ...mix, G: mix.G * gb };
    const s = Object.values(mix).reduce((a, b) => a + b, 0);
    for (const k in mix) mix[k] /= s;
  }
  return mix;
}

// spray for a right-handed batter (mirrored for lefties)
const SPRAY = { pull: 0.4, center: 0.34, oppo: 0.26 };
const G_FIELD = { pull: { 5: 0.45, 6: 0.55 }, center: { 6: 0.45, 4: 0.45, 1: 0.1 }, oppo: { 4: 0.55, 3: 0.45 } };
const OF_FIELD = { pull: 7, center: 8, oppo: 9 };
const P_FIELD = { 2: 0.15, 3: 0.2, 4: 0.2, 5: 0.2, 6: 0.25 };
const DEPTH = { shallow: 0.3, medium: 0.45, deep: 0.25 };

// Step 1: batted-ball profile -> [{p, bb, field, depth, pull}]
function profile(category, ctx) {
  const lefty = ctx.batSide === 'L';
  const f = (pos) => (lefty ? MIRROR[pos] : pos);
  const out = [];
  for (const [bb, pb] of Object.entries(bbMix(category, ctx))) {
    if (bb === 'P') {
      for (const [pos, pp] of Object.entries(P_FIELD)) out.push({ p: pb * pp, bb, field: +pos, depth: 'in', pull: 'center' });
      continue;
    }
    for (const [dir, pd] of Object.entries(SPRAY)) {
      if (bb === 'G') {
        if (category === 'B2') { // doubles on the ground go down the lines
          if (dir === 'center') continue;
          out.push({ p: pb * pd / 0.66, bb, field: f(dir === 'pull' ? 5 : 3), depth: 'line', pull: dir });
          continue;
        }
        for (const [pos, pp] of Object.entries(G_FIELD[dir])) out.push({ p: pb * pd * pp, bb, field: f(+pos), depth: 'in', pull: dir });
      } else if (bb === 'L' && category === 'OUT') {
        // line outs: 40% to infielders
        for (const [pos, pp] of Object.entries(G_FIELD[dir])) out.push({ p: pb * pd * pp * 0.4, bb, field: f(+pos), depth: 'in', pull: dir });
        out.push({ p: pb * pd * 0.6, bb, field: f(OF_FIELD[dir]), depth: 'medium', pull: dir });
      } else {
        const depths = category === 'HR' || category === 'B3' ? { deep: 1 }
          : category === 'B2' ? { medium: 0.4, deep: 0.6 }
            : bb === 'L' ? { medium: 1 } : DEPTH;
        for (const [d, p3] of Object.entries(depths)) out.push({ p: pb * pd * p3, bb, field: f(OF_FIELD[dir]), depth: d, pull: dir });
      }
    }
  }
  return out;
}

// Step 2: conversions -> [{p, category, error}]
function conversions(category, prof, ctx) {
  const align = ctx.align || ALIGN_DEFAULT;
  const d = (ctx.def && ctx.def[prof.field]) || 50;
  const res = [];
  const push = (p, cat, error = false) => { if (p > 1e-9) res.push({ p, category: cat, error }); };
  const infield = prof.field <= 6;
  const isOF = prof.field >= 7;
  let toHit = 0, toOut = 0, toSingle = 0;
  if (category === 'OUT') {
    if (prof.bb === 'G' && infield && prof.field !== 1 && prof.field !== 2) {
      if (align.inf === 'in') toHit += 0.09;
      else if (align.inf === 'corners' && (prof.field === 3 || prof.field === 5)) toHit += 0.05;
      else if (align.inf === 'dp') toHit += 0.02;
      else if (align.inf === 'lines') toHit += 0.02;
      if (align.shift && ctx.batSide === 'L' && (prof.field === 5 || prof.field === 6) && prof.pull === 'oppo') toHit += 0.3;
      if (d < 50) toHit += 0.007 * (50 - d);
    }
    if (prof.bb === 'L' && isOF && align.of === 'deep') toHit += 0.06;
    if (prof.bb === 'F' && isOF) {
      if (align.of === 'deep' && prof.depth === 'shallow') toHit += 0.25;
      if (align.of === 'shallow' && prof.depth === 'deep') toHit += 0.25;
      if (d < 50) toHit += 0.004 * (50 - d);
    }
    toHit = Math.min(0.6, toHit);
    // errors on balls that would be outs
    const lgRoe = ctx.roe || 0.014;
    const typeF = { G: 1.45, F: 0.5, L: 0.3, P: 0.3 }[prof.bb] || 1;
    const pErr = clamp(lgRoe * typeF * (1 - 0.02 * (d - 50)), 0, 0.12) * (1 - toHit);
    const hitCat = prof.bb === 'F' && prof.depth === 'deep' ? 'B2' : 'B1';
    push(toHit, hitCat);
    push(pErr, 'ROE', true);
    push(1 - toHit - pErr, 'OUT');
    return res;
  }
  if (category === 'B1' || category === 'B2' || category === 'B3') {
    if (prof.bb === 'G' && infield) {
      if (d > 50) toOut += 0.007 * (d - 50);
      if (align.shift && ctx.batSide === 'L' && (prof.field === 3 || prof.field === 4) && prof.pull === 'pull') toOut += 0.35;
    }
    if ((prof.bb === 'L' || prof.bb === 'F') && isOF) {
      if (d > 50) toOut += 0.005 * (d - 50);
      if (align.of === 'shallow' && category === 'B1') toOut += prof.bb === 'F' ? 0.25 : 0.04;
      if (align.of === 'deep' && category !== 'B1') { toOut += 0.08; toSingle += 0.3; }
    }
    if (category === 'B2' && align.inf === 'lines' && prof.depth === 'line') toSingle += 0.7;
    if (category === 'B2' && align.inf === 'lines' && (prof.field === 7 || prof.field === 9)) toSingle += 0.2;
    toOut = Math.min(0.6, toOut);
    toSingle = Math.min(1 - toOut, toSingle);
    push(toOut, 'OUT');
    push(toSingle, 'B1');
    push(1 - toOut - toSingle, category);
    return res;
  }
  push(1, category);
  return res;
}

// Probability a runner beats the throw when sent.
function sendSafeProb(kind, runner, ctx, prof, outs) {
  const spd = runner ? runner.spd : 50;
  const arm = (ctx.arms && ctx.arms[prof.field]) || 50;
  const align = ctx.align || ALIGN_DEFAULT;
  const fieldAdj = { 7: -0.08, 8: 0.03, 9: -0.02 }[prof.field] || 0;
  let p;
  if (kind === 'home-from-2nd') {
    p = 0.95 + 0.015 * (spd - 50) - 0.008 * (arm - 50) + (outs === 2 ? 0.1 : 0)
      + ({ G: 0, L: -0.25, F: -0.05 }[prof.bb] || 0) + fieldAdj
      + (align.of === 'shallow' ? -0.25 : 0) + (align.of === 'deep' ? 0.1 : 0) + (ctx.running ? 0.12 : 0);
  } else if (kind === 'home-from-1st') {
    p = 0.9 + 0.015 * (spd - 50) - 0.007 * (arm - 50) + (outs === 2 ? 0.12 : 0)
      + (prof.depth === 'deep' ? 0.05 : -0.15) + ({ G: 0.05, L: -0.1, F: 0 }[prof.bb] || 0) + fieldAdj
      + (ctx.running ? 0.2 : 0) + (align.of === 'deep' ? 0.06 : 0);
  } else if (kind === 'third-from-1st') {
    p = 0.88 + 0.015 * (spd - 50) - 0.005 * (arm - 50) + ({ 7: -0.15, 8: 0.02, 9: 0.08 }[prof.field] || 0)
      + ({ G: 0, L: -0.12, F: -0.05 }[prof.bb] || 0) + (ctx.running ? 0.15 : 0);
  } else if (kind === 'tag-home') {
    p = ({ shallow: 0.35, medium: 0.86, deep: 0.99 }[prof.depth] || 0.5) + 0.012 * (spd - 50) - 0.008 * (arm - 50);
  } else {
    p = 0.7;
  }
  return clamp(p, 0.05, 0.995);
}

// Default send rule: send only when it's close to a sure thing, unless two are out.
function autoSend(pSafe, outs, kind, ctx) {
  let t;
  if (kind === 'third-from-1st') t = 0.88;
  else if (kind === 'tag-home') t = 0.7;
  else t = outs === 2 ? 0.55 : 0.85;
  if (ctx && ctx.bigRun) t -= 0.05;
  return pSafe >= t;
}

// Step 3: advancement. bases: [r1, r2, r3] runner objects or null.
// policy(kind, runner, pSafe) -> boolean send. Returns branches:
// {p, outs (added), bases: [..], scored: [runner|'B'], note}
function advance(category, prof, ctx, outs, bases, batter, policy) {
  const [r1, r2, r3] = bases;
  const B = { batter: true, ref: batter };
  const branches = [];
  const add = (p, o, nb, scored, note) => { if (p > 1e-9) branches.push({ p, outs: o, bases: nb, scored, note }); };
  const decide = (kind, runner) => {
    const ps = sendSafeProb(kind, runner, ctx, prof, outs);
    return { send: policy(kind, runner, ps), ps };
  };
  const running = !!ctx.running;

  if (category === 'HR') {
    add(1, 0, [null, null, null], [r3, r2, r1, B].filter(Boolean), 'hr');
    return branches;
  }
  if (category === 'B3') {
    add(1, 0, [null, null, B], [r3, r2, r1].filter(Boolean), 'triple');
    return branches;
  }
  if (category === 'B2') {
    const scored = [r3, r2].filter(Boolean);
    if (r1) {
      const { send, ps } = decide('home-from-1st', r1);
      if (send) {
        add(ps, 0, [null, B, null], [...scored, r1], 'double, runner scores from first');
        add(1 - ps, 1, [null, null, B], scored, 'double, runner out at the plate');
      } else add(1, 0, [null, B, r1], scored, 'double, runner holds at third');
    } else add(1, 0, [null, B, null], scored, 'double');
    return branches;
  }
  if (category === 'B1' || category === 'ROE') {
    const base3 = r3 ? [r3] : [];
    if (category === 'ROE') {
      // error: batter to first, runners up one (two 30% of the time)
      add(0.7, 0, [B, r1, r2], base3, 'error, runners up one');
      add(0.3, 0, [B, null, r1], [...base3, r2].filter(Boolean), 'error, runners up two');
      return branches;
    }
    if (!r2 && !r1) { add(1, 0, [B, null, null], base3, 'single'); return branches; }
    // runner on 2nd: score or hold
    const branches2 = [];
    if (r2) {
      const { send, ps } = decide('home-from-2nd', r2);
      if (send) {
        branches2.push({ p: ps, scored: [r2], third: null, outAdd: 0, thrown: true });
        branches2.push({ p: 1 - ps, scored: [], third: null, outAdd: 1, thrown: true });
      } else branches2.push({ p: 1, scored: [], third: r2, outAdd: 0, thrown: false });
    } else branches2.push({ p: 1, scored: [], third: null, outAdd: 0, thrown: false });
    for (const b2 of branches2) {
      if (r1) {
        if (!b2.third) {
          const { send, ps } = running ? { send: true, ps: sendSafeProb('third-from-1st', r1, ctx, prof, outs) }
            : decide('third-from-1st', r1);
          if (send) {
            const batterTo2 = b2.thrown ? 0.35 : 0;
            add(b2.p * ps * (1 - batterTo2), b2.outAdd, [B, null, r1], [...base3, ...b2.scored], 'single, runner to third');
            add(b2.p * ps * batterTo2, b2.outAdd, [null, B, r1], [...base3, ...b2.scored], 'single, batter takes second on the throw');
            add(b2.p * (1 - ps), b2.outAdd + 1, [B, null, null], [...base3, ...b2.scored], 'single, runner thrown out at third');
          } else add(b2.p, b2.outAdd, [B, r1, null], [...base3, ...b2.scored], 'single');
        } else add(b2.p, b2.outAdd, [B, r1, b2.third], [...base3, ...b2.scored], 'single');
      } else {
        const to2 = b2.thrown ? 0.35 : 0;
        add(b2.p * (1 - to2), b2.outAdd, [B, null, b2.third], [...base3, ...b2.scored], 'single');
        if (to2) add(b2.p * to2, b2.outAdd, [null, B, b2.third], [...base3, ...b2.scored], 'single, batter takes second on the throw');
      }
    }
    return branches;
  }
  // ---- outs
  const align = ctx.align || ALIGN_DEFAULT;
  if (prof.bb === 'G') {
    if (outs === 2) { add(1, 1, [r1, r2, r3], [], 'ground out'); return branches; }
    if (r1) {
      const batSpd = batter ? batter.spd : 50;
      const midDef = (((ctx.def && ctx.def[4]) || 50) + ((ctx.def && ctx.def[6]) || 50)) / 2;
      let pdp = 0.40 + 0.006 * (50 - batSpd) + (align.inf === 'dp' ? 0.08 : 0)
        + ({ 4: 0.05, 6: 0.05, 3: -0.08, 5: 0, 1: -0.05, 2: -0.2 }[prof.field] || 0) + 0.003 * (midDef - 50);
      if (running) pdp -= 0.4;
      if (align.inf === 'in' && r3) pdp -= 0.1;
      pdp = clamp(pdp, 0.02, 0.75);
      // bases loaded, infield in: the play goes home
      if (r2 && r3 && align.inf === 'in') {
        add(0.72, 1, [B, r1, r2], [], 'force at the plate');
        add(0.28, 2, [null, r1, r2], [], 'double play, home to first');
        return branches;
      }
      // double play: with nobody out the lead runners move up and a run can score
      if (outs === 0) add(pdp, 2, [null, null, r2], r3 ? [r3] : [], 'double play');
      else add(pdp, 2, [null, null, null], [], 'double play');
      // force at second, batter safe at first
      const rest = 1 - pdp;
      if (r2 && r3) add(rest * 0.82, 1, [B, null, r2], [r3], 'force at second, a run scores');
      else if (r2) add(rest * 0.82, 1, [B, null, r2], [], 'force at second');
      else if (r3) {
        const pScore = align.inf === 'in' ? 0.15 : 0.5;
        add(rest * 0.82 * pScore, 1, [B, null, null], [r3], 'force at second, a run scores');
        add(rest * 0.82 * (1 - pScore), 1, [B, null, r3], [], 'force at second');
      } else add(rest * 0.82, 1, [B, null, null], [], 'force at second');
      // batter out at first, runners advance a base
      add(rest * 0.18, 1, [null, r1, r2], r3 ? [r3] : [], 'runners advance');
      return branches;
    }
    // no force at first
    let branchesLeft = [{ p: 1, nb: [null, r2, r3], scored: [], outAdd: 1 }];
    if (r3) {
      const pScore = align.inf === 'in' ? 0.15 : clamp(0.55 + 0.006 * ((r3.spd || 50) - 50)
        + (prof.field === 3 || prof.field === 4 ? 0.1 : 0) - (prof.field === 1 || prof.field === 5 ? 0.15 : 0), 0.1, 0.9);
      const pThrown = align.inf === 'in' ? 0.1 : 0.03;
      branchesLeft = [
        { p: pScore, nb: [null, r2, null], scored: [r3], outAdd: 1 },
        { p: pThrown, nb: [B, r2, null], scored: [], outAdd: 1 },
        { p: 1 - pScore - pThrown, nb: [null, r2, r3], scored: [], outAdd: 1 },
      ];
    }
    for (const bl of branchesLeft) {
      if (bl.nb[1] && !bl.nb[2]) {
        const pAdv = prof.field === 3 || prof.field === 4 ? 0.75 : prof.field === 5 || prof.field === 6 ? 0.25 : 0.5;
        add(bl.p * pAdv, bl.outAdd, [bl.nb[0], null, bl.nb[1]], bl.scored, 'ground out, runner advances');
        add(bl.p * (1 - pAdv), bl.outAdd, bl.nb, bl.scored, 'ground out');
      } else add(bl.p, bl.outAdd, bl.nb, bl.scored, 'ground out');
    }
    return branches;
  }
  if (prof.bb === 'F' && prof.field >= 7) {
    if (outs === 2) { add(1, 1, [r1, r2, r3], [], 'fly out'); return branches; }
    let base = [{ p: 1, nb: [r1, r2, r3], scored: [], outAdd: 1 }];
    if (r3) {
      const { send, ps } = decide('tag-home', r3);
      if (send) {
        base = [{ p: ps, nb: [r1, r2, null], scored: [r3], outAdd: 1 },
          { p: 1 - ps, nb: [r1, r2, null], scored: [], outAdd: 2 }];
      }
    }
    for (const b of base) {
      if (b.outAdd >= 2 || outs + b.outAdd >= 3) { add(b.p, b.outAdd, b.nb, b.scored, 'fly out'); continue; }
      if (b.nb[1] && !b.nb[2]) {
        const pTag = prof.depth === 'deep' ? 0.65 : prof.depth === 'medium' && prof.field === 9 ? 0.3 : 0.05;
        add(b.p * pTag, b.outAdd, [b.nb[0], null, b.nb[1]], b.scored, 'fly out, runner tags to third');
        add(b.p * (1 - pTag), b.outAdd, b.nb, b.scored, 'fly out');
      } else add(b.p, b.outAdd, b.nb, b.scored, b.scored.length ? 'sacrifice fly' : 'fly out');
    }
    return branches;
  }
  if (prof.bb === 'L' && running && outs < 2) {
    const lead = r3 || r2 || r1;
    if (lead) {
      const nb = [r1, r2, r3].map((r) => (r === lead ? null : r));
      add(0.5, 2, nb, [], 'line drive double play');
      add(0.5, 1, [r1, r2, r3], [], 'line out');
      return branches;
    }
  }
  add(1, 1, [r1, r2, r3], [], prof.bb === 'P' ? 'pop out' : 'line out');
  return branches;
}

// Full fair-ball resolution: all branches with category/profile attached.
function fairBallBranches(category, ctx, outs, bases, batter, policy) {
  const out = [];
  for (const prof of profile(category, ctx)) {
    for (const conv of conversions(category, prof, ctx)) {
      const p0 = prof.p * conv.p;
      if (p0 < 1e-7) continue;
      for (const br of advance(conv.category, prof, ctx, outs, bases, batter, policy)) {
        out.push({ ...br, p: p0 * br.p, category: conv.category, error: conv.error, prof });
      }
    }
  }
  return out;
}

Object.assign(exports, { profile, conversions, sendSafeProb, autoSend, advance, fairBallBranches, ALIGN_DEFAULT });
});
__def("engine/evaluate.js", function (exports) {
// Win probability for a live game, and grades for manager calls.

const { transitions, halfTable, runDist, homeWP, extraTied, avgFresh, MAXR, maskOf } = __req("engine/wp.js");
const { paTarget, fatigue } = __req("engine/model.js");
const { paDist, buildMatchup } = __req("engine/pitch.js");
const { fairBallBranches, autoSend, ALIGN_DEFAULT } = __req("engine/bip.js");
const { stealBranches, buntBranches, hitAndRunBranches, ibbBranches, forcedAdvance } = __req("engine/tactics.js");

const TABLES = new Map();
const FAIR = ['HR', 'B3', 'B2', 'B1', 'OUT'];

// rough run value of a pitcher's rates (lower is better)
function pitcherValue(pl, tired = 0) {
  const r = pl.p ? pl.p.r : [0.15, 0.09, 0.008, 0.025, 0.16, 0.045, 0.005];
  const [k, bb, hbp, hr, b1, b2, b3] = r;
  return (0.7 * (bb + hbp) + 0.9 * b1 + 1.25 * b2 + 1.6 * b3 + 2.0 * hr - 0.1 * k) * (1 + 0.35 * tired);
}
function hitterValue(pl) {
  const [k, bb, hbp, hr, b1, b2, b3] = pl.h;
  return 0.7 * (bb + hbp) + 0.9 * b1 + 1.25 * b2 + 1.6 * b3 + 2.0 * hr;
}

function lineupPlayers(g, team, override) {
  const list = !override ? [] : Array.isArray(override) ? override : [override];
  return team.lineup.map((x, i) => {
    const o = list.find((y) => y.slot === i);
    return g.P(o ? o.pid : x.pid);
  });
}

function teamTable(g, team, pitcherPl, tired, override) {
  const players = lineupPlayers(g, team, override);
  const key = players.map((p) => p.n).join('|') + '#' + pitcherPl.n + '#' + Math.round(tired * 10) + '#' + g.season;
  let R = TABLES.get(key);
  if (!R) {
    const dists = players.map((b) => paTarget(b, pitcherPl, { lg: g.lg, tired, tto: 0 }));
    R = halfTable(dists, transitions({ roe: g.lg.roe }));
    if (TABLES.size > 400) TABLES.clear();
    TABLES.set(key, R);
  }
  return R;
}

// Starting pitchers work out of the bullpen only when the season is on the line.
function allHands(g) {
  return /Winner-take-all|elimination/.test(g.sc.stakes || '') || g.sc.round === 'playoff';
}
function relieverPool(g, team) {
  if (allHands(g)) return team.pen;
  const pool = team.pen.filter((pid) => { const p = g.P(pid).p; return !p || p.role !== 'SP'; });
  return pool.length ? pool : team.pen;
}

// who a team will most likely pitch next half
function projectedPitcher(g, team, exclude) {
  const cur = team.pitcher && !team.removed.has(team.pitcher) && team.pitcher !== exclude ? team.pitcher : null;
  let best = null, bestV = Infinity;
  for (const pid of relieverPool(g, team)) {
    const pl = g.P(pid);
    if (!pl.p) continue;
    const t = fatigue(pl, 0, team.energy[pid] ?? 1, false);
    const v = pitcherValue(pl, t);
    if (v < bestV) { bestV = v; best = { pid, pl, tired: t }; }
  }
  if (cur) {
    const ps = team.pst[cur] || { pitches: 0 };
    const pl = g.P(cur);
    const t = fatigue(pl, ps.pitches, team.energy[cur] ?? 1, false);
    if (!best || t < 0.55 || pitcherValue(pl, t) <= bestV * 1.05) return { pid: cur, pl, tired: t };
  }
  return best || { pid: cur, pl: g.P(cur), tired: 0.3 };
}

function extraX(g, exclude) {
  const [t0, t1] = g.teams;
  const p0 = projectedPitcher(g, t0, exclude), p1 = projectedPitcher(g, t1, exclude);
  const m = g.rules.ghost ? 2 : 0;
  const Rv = teamTable(g, t0, p1.pl, p1.tired);
  const Rh = teamTable(g, t1, p0.pl, p0.tired);
  return extraTied(avgFresh(Rv, m), avgFresh(Rh, m));
}

// Distribution of further runs this half from an explicit state.
function firstStep(g, R, outs, bases, slot, dist, ctx, batterPl) {
  const out = new Float64Array(MAXR);
  const ns = (slot + 1) % 9;
  const cont = (o2, b2, runs, w) => {
    if (w <= 0) return;
    if (o2 >= 3) { out[Math.min(MAXR - 1, runs)] += w; return; }
    const d = runDist(R, o2, maskOf(b2), ns);
    for (let k = 0; k < MAXR; k++) out[Math.min(MAXR - 1, k + runs)] += w * d[k];
  };
  if (dist.K) cont(outs + 1, bases, 0, dist.K);
  const walk = (dist.BB || 0) + (dist.HBP || 0);
  if (walk) { const f = forcedAdvance(bases); cont(outs, f.bases, f.scored.length, walk); }
  const policy = (kind, runner, ps) => autoSend(ps, outs, kind, ctx);
  for (const cat of FAIR) {
    const pc = dist[cat];
    if (!pc) continue;
    for (const br of fairBallBranches(cat, ctx, outs, bases, batterPl, policy)) {
      const o2 = outs + br.outs;
      const runs = o2 >= 3 && /double play|force|ground/.test(br.note || '') ? 0 : br.scored.length;
      cont(o2, br.bases, runs, pc * br.p);
    }
  }
  return out;
}

// rest-of-half distribution after tactic branches
function fromBranches(g, R, branches, outs, slot, ctx, batterPl, M) {
  const out = new Float64Array(MAXR);
  for (const br of branches) {
    if (br.p <= 0) continue;
    const o2 = outs + br.outs;
    const runs = o2 >= 3 && /double play|force/.test(br.note || '') ? 0 : br.scored.length;
    let d;
    if (o2 >= 3) { out[Math.min(MAXR - 1, runs)] += br.p; continue; }
    if (br.sameBatter) {
      const dist = M ? paDist(M, br.count.b, br.count.s) : paTarget(batterPl, ctx.pitcherPl, { lg: g.lg, tired: ctx.tired || 0 });
      d = firstStep(g, R, o2, br.bases, slot, dist, ctx, batterPl);
    } else d = runDist(R, o2, maskOf(br.bases), (slot + 1) % 9);
    for (let k = 0; k < MAXR; k++) out[Math.min(MAXR - 1, k + runs)] += br.p * d[k];
  }
  return out;
}

function nextHalfDist(g, exclude) {
  // home team batting next half (only needed while the visitors bat)
  const home = g.teams[1], vis = g.teams[0];
  const pp = projectedPitcher(g, vis, exclude);
  const R = teamTable(g, home, pp.pl, pp.tired);
  return runDist(R, 0, 0, home.slot);
}

function wrap(g, cur, exclude) {
  const diff = g.score[1] - g.score[0];
  const X = extraX(g, exclude);
  const next = g.half === 0 ? nextHalfDist(g, exclude) : null;
  return homeWP(g.half, diff, cur, next, X);
}

// Home team win probability right now (between pitches).
function winProb(g) {
  if (g.over) return g.winner === 1 ? 1 : 0;
  const bt = g.bat(), ft = g.fld();
  if (!ft.pitcher || ft.removed.has(ft.pitcher)) {
    const pp = projectedPitcher(g, ft);
    return evalDefense(g, { pid: pp.pid }).wp;
  }
  const pitcherPl = g.P(ft.pitcher);
  const tired = g.pitcherTired(ft);
  const R = teamTable(g, bt, pitcherPl, tired);
  const M = g.matchup();
  const dist = paDist(M, g.count.b, g.count.s);
  const ctx = g.situationCtx();
  const cur = firstStep(g, R, g.outs, g.baseState(), bt.slot, dist, ctx, g.P(g.batter().pid));
  return wrap(g, cur);
}

const forSide = (wpHome, side) => (side === 1 ? wpHome : 1 - wpHome);

// ---------------------------------------------------------------- defense options
// opt: { pid (pitcher), ibb: bool, align: {inf, of, shift} }
function evalDefense(g, opt) {
  const bt = g.bat(), ft = g.fld();
  const pid = opt.pid || ft.pitcher;
  const pl = g.P(pid);
  const isCur = pid === ft.pitcher;
  const ps = ft.pst[pid];
  const cold = !isCur && !(ft.warming[pid] >= 0.9) && g.paNo !== g.halfStartPA;
  const tired = isCur ? g.pitcherTired(ft) : fatigue(pl, 0, ft.energy[pid] ?? 1, cold);
  const R = teamTable(g, bt, pl, tired);
  const batterPl = g.P(g.batter().pid);
  const ctx = { ...g.situationCtx(), align: opt.align || ft.align, pitcherPl: pl, tired, pitcherThrows: pl.t };
  let cur;
  if (opt.ibb) {
    cur = fromBranches(g, R, ibbBranches(g.baseState()), g.outs, bt.slot, ctx, batterPl, null);
  } else {
    const dist = isCur ? paDist(g.matchup(), g.count.b, g.count.s)
      : paTarget(batterPl, pl, { lg: g.lg, tired, tto: 0 });
    cur = firstStep(g, R, g.outs, g.baseState(), bt.slot, dist, ctx, batterPl);
  }
  return { wp: wrap(g, cur) };
}

// ---------------------------------------------------------------- offense options
// opt: { ph: pid|null, pr: {base, pid}|null, tactic: 'swing'|'take'|'sac'|'squeeze'|'safety'|'drag'|'steal2'|'steal3'|'steal4'|'double'|'hitrun' }
const MATCHUPS = new Map();
function matchupFor(g, batterPl, pitcherPl, tired) {
  const key = batterPl.n + '|' + pitcherPl.n + '|' + Math.round(tired * 20) + '|' + g.season;
  let M = MATCHUPS.get(key);
  if (!M) {
    M = buildMatchup(batterPl, pitcherPl, { lg: g.lg, tired, tto: 0 });
    if (MATCHUPS.size > 200) MATCHUPS.clear();
    MATCHUPS.set(key, M);
  }
  return M;
}

function evalOffense(g, opt) {
  // opt: { batter: pid (who bats in this slot), runners: [pid|null x3] (who is on base), tactic }
  const bt = g.bat(), ft = g.fld();
  const pitcherPl = g.P(ft.pitcher);
  const tired = g.pitcherTired(ft);
  const slot = bt.slot;
  const batterPid = opt.batter || g.batter().pid;
  const batterPl = g.P(batterPid);
  const override = batterPid !== bt.lineup[slot].pid ? { slot, pid: batterPid } : null;
  const overrides = override ? [override] : [];
  let bases = g.baseState();
  if (opt.runners) {
    bases = bases.map((r, i) => {
      if (!(r && opt.runners[i] && opt.runners[i] !== r.pid)) return r;
      const rs = bt.lineup.findIndex((x) => x.pid === r.pid);
      if (rs >= 0) overrides.push({ slot: rs, pid: opt.runners[i] });
      return { ...g.runnerObj(opt.runners[i]), resp: r.resp };
    });
  }
  const R = teamTable(g, bt, pitcherPl, tired, overrides);
  const ctx = { ...g.situationCtx(), pitcherPl, tired, pitcherStuff: pitcherPl.p ? pitcherPl.p.stf : 45 };
  const count = g.count;
  const M = override ? matchupFor(g, batterPl, pitcherPl, tired) : g.matchup();
  const zoneP = 0.47;
  let cur;
  switch (opt.tactic || 'swing') {
    case 'take': cur = firstStep(g, R, g.outs, bases, slot, paDist(M, count.b, count.s, 'takeUntilStrike'), ctx, batterPl); break;
    case 'sac': case 'squeeze': case 'safety': case 'drag':
      cur = fromBranches(g, R, buntBranches(opt.tactic, bases, g.outs, batterPl, ctx, count), g.outs, slot, ctx, batterPl, M); break;
    case 'steal2': case 'steal3': case 'steal4': case 'double': {
      const which = opt.tactic === 'double' ? 'double' : +opt.tactic.slice(-1);
      cur = fromBranches(g, R, stealBranches(bases, which, ctx, count, zoneP), g.outs, slot, ctx, batterPl, M); break;
    }
    case 'hitrun':
      cur = fromBranches(g, R, hitAndRunBranches(M, bases, g.outs, batterPl, count, ctx), g.outs, slot, ctx, batterPl, M); break;
    default: cur = firstStep(g, R, g.outs, bases, slot, paDist(M, count.b, count.s), ctx, batterPl);
  }
  // pinch-hitting for your own pitcher means a new pitcher next half
  const replaced = bt.lineup[slot].pid;
  const exclude = override && replaced === bt.pitcher ? replaced : undefined;
  return { wp: wrap(g, cur, exclude) };
}

// ---------------------------------------------------------------- option sets
function tacticOptions(g) {
  const b = g.bases, outs = g.outs;
  const opts = ['swing'];
  if (g.count.s < 2) opts.push('take');
  if (outs < 2 && (b[0] || b[1])) opts.push('sac');
  if (outs < 2 && b[2]) { opts.push('squeeze'); opts.push('safety'); }
  if (!b[0] && !b[1] && !b[2]) opts.push('drag');
  if (b[0] && !b[1]) opts.push('steal2');
  if (b[1] && !b[2]) opts.push('steal3');
  if (b[0] && b[1] && !b[2]) opts.push('double');
  if (b[0] && !b[1] && outs < 2 && g.count.s < 2) opts.push('hitrun');
  return opts;
}

function defenseOptions(g, opts = {}) {
  const ft = g.fld();
  const pitchers = [];
  if (ft.pitcher && !ft.removed.has(ft.pitcher)) pitchers.push(ft.pitcher);
  const canChange = g.canChangePitcher(ft.side).ok || !ft.pitcher || ft.removed.has(ft.pitcher);
  if (canChange) {
    const batterPl = g.P(g.batter().pid);
    const ranked = relieverPool(g, ft).map((pid) => {
      const pl = g.P(pid);
      const t = fatigue(pl, 0, ft.energy[pid] ?? 1, false);
      const d = paTarget(batterPl, pl, { lg: g.lg, tired: t });
      const v = 0.7 * (d.BB + d.HBP) + 0.9 * d.B1 + 1.25 * d.B2 + 1.6 * d.B3 + 2 * d.HR - 0.1 * d.K;
      return { pid, v };
    }).sort((a, b) => a.v - b.v);
    for (const r of ranked.slice(0, opts.maxPitchers || 4)) pitchers.push(r.pid);
  }
  const b = g.bases;
  const infs = ['normal'];
  if (b[2] && g.outs < 2) infs.push('in');
  if (b[0] && g.outs < 2) infs.push('dp');
  if (!b[2] && (b[0] || b[1]) && g.outs < 2 && g.bat().lineup) infs.push('corners');
  const ofs = ['normal'];
  if (b[1] || b[2]) ofs.push('shallow');
  if (g.inning >= 8) ofs.push('deep');
  const ibbs = [false];
  if (!g.paStarted || g.count.b + g.count.s >= 0) ibbs.push(true);
  return { pitchers, infs, ofs, ibbs };
}

function offenseOptions(g, opts = {}) {
  const bt = g.bat(), ft = g.fld();
  const pitcherPl = g.P(ft.pitcher);
  const curPl = g.P(g.batter().pid);
  const batters = [];
  if (!g.paStarted) {
    const ranked = bt.bench.map((pid) => {
      const pl = g.P(pid);
      const d = paTarget(pl, pitcherPl, { lg: g.lg, tired: 0 });
      return { pid, v: 0.7 * (d.BB + d.HBP) + 0.9 * d.B1 + 1.25 * d.B2 + 1.6 * d.B3 + 2 * d.HR };
    }).sort((a, b) => b.v - a.v);
    const cd = paTarget(curPl, pitcherPl, { lg: g.lg, tired: 0 });
    const curV = 0.7 * (cd.BB + cd.HBP) + 0.9 * cd.B1 + 1.25 * cd.B2 + 1.6 * cd.B3 + 2 * cd.HR;
    for (const r of ranked.slice(0, opts.maxPH || 3)) if (r.v > curV * 0.92) batters.push(r.pid);
  }
  // pinch runner for the lead runner when a much faster player is on the bench
  const runners = [null];
  const leadBase = g.bases[2] ? 3 : g.bases[1] ? 2 : g.bases[0] ? 1 : 0;
  if (leadBase) {
    const lead = g.bases[leadBase - 1];
    const fast = bt.bench.map((pid) => ({ pid, spd: g.P(pid).spd || 50 })).sort((a, b) => b.spd - a.spd)[0];
    if (fast && fast.spd >= (lead.spd || 50) + 10) runners.push({ base: leadBase, pid: fast.pid });
  }
  return { batters, runners, tactics: tacticOptions(g) };
}

// ---------------------------------------------------------------- grading
function gradeOf(delta) {
  const d = delta * 100;
  if (d <= 0.75) return 'green';
  if (d <= 2.25) return 'yellow';
  if (d <= 5) return 'orange';
  return 'red';
}

// Score every defensive call and grade the chosen one (from the fielding side's view).
// chosen: { pid, ibb, align }; base: { pid } the pitcher before any change this PA
function gradeDefense(g, chosen, base = {}, opts = {}) {
  const side = 1 - g.half;
  const o = defenseOptions(g);
  const { pitchers, ibbs } = o;
  const infs = opts.fixedAlign ? ['normal'] : o.infs;
  const ofs = opts.fixedAlign ? ['normal'] : o.ofs;
  for (const pid of [chosen.pid, base.pid]) if (pid && !pitchers.includes(pid)) pitchers.push(pid);
  const curAlign = g.fld().align;
  const results = [];
  for (const pid of pitchers) {
    for (const ibb of ibbs) {
      const aligns = ibb ? [{ inf: 'normal', of: 'normal' }] : infs.flatMap((inf) => ofs.map((of) => ({ inf, of })));
      for (const al of aligns) {
        const align = { ...curAlign, inf: al.inf, of: al.of };
        results.push({ pid, ibb, align, wp: forSide(evalDefense(g, { pid, ibb, align }).wp, side) });
      }
    }
  }
  const chosenAlign = { ...curAlign, ...(chosen.align || {}) };
  const mine = forSide(evalDefense(g, { pid: chosen.pid || g.fld().pitcher, ibb: !!chosen.ibb, align: chosenAlign }).wp, side);
  results.sort((a, b) => b.wp - a.wp);
  const best = results[0];
  return { grade: gradeOf(Math.max(0, best.wp - mine)), mine, best, delta: Math.max(0, best.wp - mine), results };
}

// chosen: { batter, runners, tactic }; base: { batter, runners } before any change this PA
function gradeOffense(g, chosen, base = {}) {
  const side = g.half;
  const { batters, runners, tactics } = offenseOptions(g);
  const bt = g.bat();
  const baseBatter = base.batter || bt.lineup[bt.slot].pid;
  const baseRunners = base.runners || g.bases.map((r) => (r ? r.pid : null));
  const batterSet = new Set([baseBatter, chosen.batter || bt.lineup[bt.slot].pid]);
  for (const b of batters) if (b) batterSet.add(b);
  const runnerSets = [baseRunners];
  if (chosen.runners) runnerSets.push(chosen.runners);
  for (const r of runners) {
    if (!r) continue;
    const rs = [...baseRunners];
    rs[r.base - 1] = r.pid;
    runnerSets.push(rs);
  }
  if (!tactics.includes(chosen.tactic || 'swing')) tactics.push(chosen.tactic || 'swing');
  const results = [];
  for (const batter of batterSet) {
    for (const rs of runnerSets) {
      for (const tactic of tactics) {
        results.push({ batter, runners: rs, tactic, wp: forSide(evalOffense(g, { batter, runners: rs, tactic }).wp, side) });
      }
    }
  }
  const mine = forSide(evalOffense(g, { batter: chosen.batter, runners: chosen.runners, tactic: chosen.tactic || 'swing' }).wp, side);
  results.sort((a, b) => b.wp - a.wp);
  const best = results[0];
  return { grade: gradeOf(Math.max(0, best.wp - mine)), mine, best, delta: Math.max(0, best.wp - mine), results };
}

// ---------------------------------------------------------------- one pitch
// Home win probability after each way the next pitch can end, with the same
// batter and runners: ball, strike, foul, hit by pitch, and a ball in play by
// result (HR, B3, B2, B1, OUT). Used to grade single pitch calls and signs.
function pitchOutcomes(g) {
  const bt = g.bat(), ft = g.fld();
  if (g.over || !ft.pitcher || ft.removed.has(ft.pitcher)) return null;
  const pitcherPl = g.P(ft.pitcher);
  const R = teamTable(g, bt, pitcherPl, g.pitcherTired(ft));
  const M = g.matchup();
  const ctx = g.situationCtx();
  const batterPl = g.P(g.batter().pid);
  const bases = g.baseState();
  const { b, s } = g.count;
  const outs = g.outs, slot = bt.slot;
  const wpOf = (branches) => wrap(g, fromBranches(g, R, branches, outs, slot, ctx, batterPl, M));
  const stay = (count) => [{ p: 1, outs: 0, bases, scored: [], sameBatter: true, count }];
  const w = forcedAdvance(bases);
  const walk = [{ p: 1, outs: 0, bases: w.bases, scored: w.scored, pa: 'BB' }];
  const policy = (kind, runner, ps) => autoSend(ps, outs, kind, ctx);
  return {
    M,
    ball: wpOf(b === 3 ? walk : stay({ b: b + 1, s })),
    strike: wpOf(s === 2 ? [{ p: 1, outs: 1, bases, scored: [], pa: 'K' }] : stay({ b, s: s + 1 })),
    foul: wpOf(stay({ b, s: Math.min(2, s + 1) })),
    hbp: wpOf(walk),
    bip: FAIR.map((cat) => wpOf(fairBallBranches(cat, ctx, outs, bases, batterPl, policy))),
  };
}

// Expected home win probability of one pitch. choices: [weight, type index,
// distribution over the 25 cells where it actually arrives]; the hitter's sign
// is an approach plus an optional look.
function pitchValue(O, choices, count, approach, look, seq) {
  const M = O.M;
  let ev = 0, tot = 0;
  for (const [w, ti, actual] of choices) {
    for (let cell = 0; cell < 25; cell++) {
      const pc = w * actual[cell];
      if (pc < 1e-9) continue;
      const r = M.pitchProbs(cell, ti, count, approach, seq, look);
      let bip = 0;
      if (r.inplay > 0) {
        const d = M.bipDist(r.dmg);
        for (let i = 0; i < 5; i++) bip += d[i] * O.bip[i];
      }
      ev += pc * (r.ball * O.ball + (r.cstr + r.sstr) * O.strike + r.foul * O.foul + r.hbp * O.hbp + r.inplay * bip);
      tot += pc;
    }
  }
  return tot > 0 ? ev / tot : 0;
}

// Grades for one pitch call are on a finer scale than manager calls.
function pitchGradeOf(delta) {
  const d = delta * 100;
  if (d <= 0.2) return 'green';
  if (d <= 0.6) return 'yellow';
  if (d <= 1.2) return 'orange';
  return 'red';
}

function clearCaches() { TABLES.clear(); MATCHUPS.clear(); }

Object.assign(exports, { pitcherValue, hitterValue, allHands, relieverPool, projectedPitcher, winProb, evalDefense, evalOffense, tacticOptions, defenseOptions, offenseOptions, gradeOf, gradeDefense, gradeOffense, pitchOutcomes, pitchValue, pitchGradeOf, clearCaches, forSide });
});
__def("engine/game.js", function (exports) {
// Game state machine for one scenario: the 9th inning and any extras.
//
// The UI (or the AI) drives it with:
//   g.pitch({ call, sign, defense })   one pitch
//   g.ibb(), g.pickoff(base), g.visit()
//   g.changePitcher(pid, opts), g.pinchHit(pid), g.pinchRun(base, pid),
//   g.defSub(slot, pid, pos), g.movePos(slot, pos), g.setAlign(side, align), g.warm(pid)
//   g.answer(choice)                    resolve a pending decision (send/hold)
// Everything that happens is appended to g.log.

const { makeRng } = __req("engine/rng.js");
const { fatigue } = __req("engine/model.js");
const { buildMatchup, catcherCall, deliver, resolveAtPlate, cellV, cellH, PITCH_TYPES, inZone } = __req("engine/pitch.js");
const { profile, conversions, advance, autoSend, ALIGN_DEFAULT } = __req("engine/bip.js");
const { stealBranches, buntBranches, hitAndRunBranches, ibbBranches, forcedAdvance, stealProb } = __req("engine/tactics.js");
const { describeFair, joinNames, fielderName, fieldName } = __req("engine/text.js");

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const POS_ABBR = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH', 11: 'PH', 12: 'PR' };


const GENERIC = { n: 'Unknown player', l: 'Player', b: 'R', t: 'R', h: [0.16, 0.08, 0.008, 0.02, 0.15, 0.04, 0.005], spd: 45, stl: 0.65, bnt: 45, d: {}, arm: 50 };

function createGame(sc, shard, opts = {}) {
  const season = sc.rules.season;
  const lg = shard.league[String(season)] || Object.values(shard.league)[0];
  const P = (pid) => (pid && shard.players[`${pid}:${season}`]) || { ...GENERIC, n: pid || 'Unknown', l: pid || '' };
  const seed = opts.seed || `${sc.id}:${Date.now()}`;
  const g = {
    sc, shard, lg, season, rules: sc.rules, P, seed,
    rng: makeRng(seed),
    userSide: opts.userSide === undefined ? sc.side : opts.userSide,
    inning: 9, half: 0, outs: 0, bases: [null, null, null],
    score: [...sc.score9],
    line: [[...sc.line[0]], [...sc.line[1]]],
    hits: [sc.start.he ? sc.start.he[0][0] : 0, sc.start.he ? sc.start.he[1][0] : 0],
    errors: [sc.start.he ? sc.start.he[0][1] : 0, sc.start.he ? sc.start.he[1][1] : 0],
    count: { b: 0, s: 0 }, seq: [],
    log: [], over: false, winner: null, pending: null,
    paNo: 0, pitchNo: 0, paPitches: 0, pickoffsThisPA: 0,
    lines: JSON.parse(JSON.stringify(sc.start.lines || {})),
    teams: [0, 1].map((side) => makeTeam(sc, side, P)),
    listeners: [],
    histIdx: 0,
  };
  g.teams.forEach((t) => {
    for (const [pid, pc] of Object.entries(sc.start.pcount || {})) {
      if (pid === t.pitcher) t.pst[pid] = { pitches: Math.round(pc[0]), bf: pc[1], est: pc[2], faced: {}, entered: { inning: 1, half: 0 }, cold: false, stint: 99 };
    }
    if (t.pitcher && !t.pst[t.pitcher]) t.pst[t.pitcher] = { pitches: 0, bf: 0, faced: {}, entered: { inning: 1, half: 0 }, cold: false, stint: 99 };
  });
  Object.assign(g, api);
  const startIdx = opts.startIdx || 0;
  if (startIdx > 0) g.replayHistory(startIdx);
  g.line[0][g.inning - 1] = g.line[0][g.inning - 1] || 0;
  g.startHalfIfNeeded = true;
  g.beginPA();
  return g;
}

function makeTeam(sc, side, P) {
  const st = sc.start;
  const lineup = st.lineups[side].map(([pid, pos]) => ({ pid, pos }));
  const pitcher = st.pitchers[side];
  const removed = new Set(st.removed[side]);
  const inLineup = new Set(lineup.map((x) => x.pid));
  const energy = {};
  const bench = [], pen = [];
  for (const e of sc.roster[side]) {
    energy[e.p] = e.en;
    if (removed.has(e.p) || inLineup.has(e.p) || e.p === pitcher) continue;
    const pl = P(e.p);
    const isPitcher = !!pl.p && (e.k.includes('p') || !e.k.includes('b'));
    const twoWay = pl.p && e.k.includes('b') && pl.bl && pl.bl[6] > 150;
    if (isPitcher && !twoWay) pen.push(e.p);
    else bench.push(e.p);
  }
  if (pitcher && energy[pitcher] === undefined) energy[pitcher] = 1;
  return {
    side, code: sc.teams[side].code, nick: sc.teams[side].nick, city: sc.teams[side].city,
    lineup, slot: st.due[side] || 0, pitcher, pst: {}, energy, bench, pen, removed,
    warming: {}, visits: {}, align: { ...ALIGN_DEFAULT }, dh: sc.rules.dh,
    challengeLeft: sc.rules.replay ? 1 : 0,
  };
}

const api = {
  // ---------------------------------------------------------------- helpers
  bat() { return this.teams[this.half]; },
  fld() { return this.teams[1 - this.half]; },
  batter() { const t = this.bat(); return t.lineup[t.slot]; },
  pitcherObj() { return this.P(this.fld().pitcher); },
  isUser(side) { return side === this.userSide; },
  emit(ev) {
    ev.inning = this.inning; ev.half = this.half;
    this.log.push(ev);
    for (const fn of this.listeners) fn(ev);
    return ev;
  },
  fielders(team) {
    const f = {};
    for (const x of team.lineup) if (x.pos >= 1 && x.pos <= 9) f[x.pos] = x.pid;
    if (team.dh || !f[1]) f[1] = team.pitcher;
    return f;
  },
  defRatings(team) {
    const f = this.fielders(team);
    const d = {};
    for (let pos = 1; pos <= 9; pos++) {
      const pl = this.P(f[pos]);
      d[pos] = pos === 1 ? 50 : (pl.d && pl.d[pos] !== undefined ? pl.d[pos] : (pl.d && Object.keys(pl.d).length ? 30 : 40));
    }
    return d;
  },
  armRatings(team) {
    const f = this.fielders(team);
    const a = {};
    for (const pos of [2, 7, 8, 9]) a[pos] = this.P(f[pos]).arm || 50;
    return a;
  },
  pitcherTired(team) {
    const pid = team.pitcher;
    if (!pid) return 0;
    const ps = team.pst[pid] || { pitches: 0 };
    return fatigue(this.P(pid), ps.pitches, team.energy[pid] ?? 1, ps.cold && ps.stint < 2);
  },
  runnerObj(pid) {
    const pl = this.P(pid);
    return { pid, name: pl.l || pl.n, spd: pl.spd || 50, stl: pl.stl || 0.65, resp: this.fld().pitcher };
  },
  baseState() { return this.bases.map((r) => (r ? { ...r } : null)); },
  // timesThrough: how many times this batter has seen this pitcher today
  tto(team, pid) {
    const ps = team.pst[team.pitcher];
    if (!ps) return 0;
    if (ps.faced[pid] !== undefined) return ps.faced[pid];
    return ps.stint >= 99 ? Math.floor((ps.bf || 0) / 9) : 0;
  },
  matchup() {
    const bt = this.bat(), ft = this.fld();
    const b = this.batter();
    const loaded = !!(this.bases[0] && this.bases[1] && this.bases[2]);
    const key = `${b.pid}|${ft.pitcher}|${Math.round(this.pitcherTired(ft) * 20)}|${this.tto(ft, b.pid)}|${loaded}`;
    if (this._mkey !== key) {
      this._mkey = key;
      this._m = buildMatchup(this.P(b.pid), this.pitcherObj(), { lg: this.lg, tired: this.pitcherTired(ft), tto: this.tto(ft, b.pid), basesLoaded: loaded });
    }
    return this._m;
  },
  situationCtx(extra = {}) {
    const ft = this.fld();
    const b = this.P(this.batter().pid);
    const pit = this.pitcherObj();
    const side = b.b === 'B' ? (pit.t === 'L' ? 'R' : 'L') : (b.b === 'L' ? 'L' : 'R');
    return {
      lg: this.lg, roe: this.lg.roe || 0.014, def: this.defRatings(ft), arms: this.armRatings(ft),
      align: ft.align, batSide: side, catcherArm: this.armRatings(ft)[2],
      lateClose: this.inning >= 8 && Math.abs(this.score[0] - this.score[1]) <= 2,
      pitcherStuff: pit.p ? pit.p.stf : 45,
      pitcherThrows: pit.t, bigBases: this.rules.bigBases, pickoffs: this.pickoffsThisPA,
      gbTilt: 1, ...extra,
    };
  },
  bigRun(runner) {
    // would this runner's run tie the game or put his team ahead, late?
    if (this.inning < 8) return false;
    const me = this.half, diff = this.score[me] - this.score[1 - me];
    return diff <= 0 && diff >= -1;
  },

  // ---------------------------------------------------------------- history
  replayHistory(upto) {
    const hist = this.sc.history;
    for (let i = 0; i < upto && i < hist.length; i++) {
      const h = hist[i];
      this.applySubs(h.subs || []);
      const team = this.teams[h.h];
      const ft = this.teams[1 - h.h];
      this.inning = h.i; this.half = h.h;
      // pitch count for the pitcher on the mound
      const ps = ft.pst[h.p] || (ft.pst[h.p] = { pitches: 0, bf: 0, faced: {}, entered: { inning: h.i, half: h.h }, cold: false, stint: 0 });
      ps.pitches += h.n || 0;
      if (h.pa) { ps.bf += 1; ps.stint += 1; ps.faced[h.b] = (ps.faced[h.b] || 0) + 1; }
      const runs = h.s1[h.h] - (h.s0 ? h.s0[h.h] : this.score[h.h]);
      if (runs > 0) this.line[h.h][h.i - 1] = (this.line[h.h][h.i - 1] || 0) + runs;
      else this.line[h.h][h.i - 1] = this.line[h.h][h.i - 1] || 0;
      this.score = [...h.s1];
      if (/^(S|D|T|H|HR|DGR)\d?/.test(h.ev) && !/^SB/.test(h.ev)) this.hits[h.h] += 1;
      if (/^E\d/.test(h.ev)) this.errors[1 - h.h] += 1;
      this.outs = h.o1;
      this.bases = h.r1.map((pid) => (pid ? { ...this.runnerObj(pid), resp: h.p } : null));
      team.slot = h.pa ? (h.lp + 1) % 9 : h.lp;
      this.emit({ kind: 'history', text: h.t, side: h.h });
      if (this.outs >= 3) this.nextHalf(true);
    }
    this.histIdx = upto;
  },
  applySubs(subs) {
    for (const s of subs) {
      const team = this.teams[s.t];
      const outPid = s.out;
      if (s.k === 'pos') { if (s.slot !== undefined) team.lineup[s.slot].pos = s.pos; continue; }
      if (s.k === 'pitch') {
        const old = team.pitcher;
        if (old && old !== s.in) team.removed.add(old);
        team.pitcher = s.in;
        team.pst[s.in] = team.pst[s.in] || { pitches: 0, bf: 0, faced: {}, entered: { inning: this.inning, half: this.half }, cold: false, stint: 0 };
        if (s.slot !== undefined && s.slot !== null) {
          const prev = team.lineup[s.slot].pid;
          if (prev !== s.in) team.removed.add(prev);
          team.lineup[s.slot] = { pid: s.in, pos: 1 };
        }
      } else if (s.slot !== undefined && s.slot !== null) {
        team.lineup[s.slot] = { pid: s.in, pos: s.pos };
        if (outPid) team.removed.add(outPid);
        if (s.k === 'pr') {
          for (let i = 0; i < 3; i++) if (this.bases[i] && this.bases[i].pid === outPid) this.bases[i] = { ...this.runnerObj(s.in), resp: this.bases[i].resp };
        }
      }
      team.bench = team.bench.filter((p) => p !== s.in);
      team.pen = team.pen.filter((p) => p !== s.in);
    }
  },

  // ---------------------------------------------------------------- flow
  nextHalf(fromHistory = false) {
    const wasHalf = this.half;
    this.emit({ kind: 'halfEnd', text: `End of the ${wasHalf === 0 ? 'top' : 'bottom'} of the ${ordinal(this.inning)}.` });
    // game over checks
    if (this.inning >= 9) {
      const [v, h] = this.score;
      if (wasHalf === 0 && h > v) return this.endGame(1);
      if (wasHalf === 1 && v !== h) return this.endGame(v > h ? 0 : 1);
    }
    if (wasHalf === 0) this.half = 1;
    else { this.half = 0; this.inning += 1; }
    this.outs = 0;
    this.bases = [null, null, null];
    this.count = { b: 0, s: 0 };
    this.line[this.half][this.inning - 1] = this.line[this.half][this.inning - 1] || 0;
    // relievers who were warming stay loose; visits reset
    for (const t of this.teams) t.visits = {};
    if (!fromHistory && this.rules.ghost && this.inning >= 10) {
      const bt = this.bat();
      const prevSlot = (bt.slot + 8) % 9;
      this.bases[1] = this.runnerObj(bt.lineup[prevSlot].pid);
      this.emit({ kind: 'note', text: `${this.bases[1].name} starts the inning on second base.` });
    }
    this.newHalf = true;
  },
  endGame(winner) {
    this.over = true;
    this.winner = winner;
    this.pending = null;
    const t = this.teams[winner];
    this.emit({ kind: 'final', text: `Final: ${this.teams[0].nick} ${this.score[0]}, ${this.teams[1].nick} ${this.score[1]}. ${t.nick} win.` });
    return true;
  },
  // fielding team must have a pitcher and a full defense before a pitch
  defenseIssues(team) {
    const issues = [];
    if (!team.pitcher || team.removed.has(team.pitcher)) issues.push({ kind: 'needPitcher' });
    const f = this.fielders(team);
    for (let pos = 2; pos <= 9; pos++) if (!f[pos]) issues.push({ kind: 'needFielder', pos });
    return issues;
  },
  autoDefense(team) {
    // PH/PR left in the game take the open positions
    const f = this.fielders(team);
    const open = [];
    for (let pos = 2; pos <= 9; pos++) if (!f[pos]) open.push(pos);
    for (const x of team.lineup) {
      if ((x.pos === 11 || x.pos === 12) && open.length) {
        const pl = this.P(x.pid);
        // prefer a position he plays
        let pick = open.findIndex((p) => pl.d && pl.d[p] !== undefined);
        if (pick < 0) pick = 0;
        x.pos = open.splice(pick, 1)[0];
      }
    }
    // a pinch hitter or runner for the DH stays on as the DH; one who replaced
    // the pitcher (no DH) leaves a spot the new pitcher will fill
    for (const x of team.lineup) {
      if ((x.pos === 11 || x.pos === 12) && !open.length) {
        if (team.dh) x.pos = 10;
        else x.needPitcher = true;
      }
    }
  },
  beginPA() {
    if (this.over) return;
    const bt = this.bat(), ft = this.fld();
    if (this.newHalf || this.startHalfIfNeeded) {
      this.newHalf = false;
      this.startHalfIfNeeded = false;
      this.autoDefense(ft);
      this.halfStartPA = this.paNo;
      this.emit({ kind: 'halfStart', text: `${this.half === 0 ? 'Top' : 'Bottom'} of the ${ordinal(this.inning)}. ${ft.nick} take the field.` });
    }
    this.count = { b: 0, s: 0 };
    this.seq = [];
    this.paPitches = 0;
    this.pickoffsThisPA = 0;
    this.paStarted = false;
    this.paSign = null;
    this.visitBoost = this.visitBoost > 0 ? this.visitBoost - 1 : 0;
    const issues = this.defenseIssues(ft);
    if (issues.some((i) => i.kind === 'needPitcher')) {
      if (this.isUser(ft.side)) this.pending = { kind: 'needPitcher', side: ft.side };
    } else this.pending = null;
    this.emit({ kind: 'paStart', batter: this.batter().pid, side: this.half });
    this._mkey = null;
  },

  // ---------------------------------------------------------------- pitching
  pitch({ call = null, sign = {}, defense = {} } = {}) {
    if (this.over || this.pending) return null;
    const ft = this.fld();
    if (this.defenseIssues(ft).length) {
      this.autoDefense(ft);
      if (this.defenseIssues(ft).some((i) => i.kind === 'needPitcher')) return null;
    }
    if (!this.paStarted) {
      this.paStarted = true;
      this.emit({ kind: 'firstPitch', sign, defense });
    }
    const M = this.matchup();
    const countKey = `${this.count.b}-${this.count.s}`;
    const ctx = this.situationCtx();
    this.pitchNo++;
    this.paPitches++;
    ft.pst[ft.pitcher].pitches += 1;
    for (const pid of Object.keys(ft.warming)) ft.warming[pid] = Math.min(1.2, ft.warming[pid] + 1 / 12);

    let ti, target;
    if (defense.pitchout) { ti = 0; target = cellIndexSafe(-2, 1); }
    else if (call && call.ti !== undefined) { ti = call.ti; target = call.target; }
    else { const c = catcherCall(M, countKey, this.rng); ti = c.ti; target = c.target; }
    const cell = deliver(M, ti, target, this.rng, defense.slideStep ? 0.08 : 0);
    const type = M.types[ti];
    const pitchInfo = { ti, type: type.key, name: PITCH_TYPES[type.key] ? PITCH_TYPES[type.key].short : type.key, target, cell, inZone: inZone(cell) };
    if (defense.pitchout) ctx.pitchout = true;

    if (sign.bunt) {
      const brs = buntBranches(sign.bunt, this.baseState(), this.outs, this.P(this.batter().pid), ctx, this.count);
      this.seq.push({ ti, cell });
      return this.applyBranch(brs[this.rng.pickIndex(brs.map((b) => b.p))], { pitch: pitchInfo, kind: 'bunt', sign });
    }
    if (sign.hitRun && this.bases[0]) {
      const brs = hitAndRunBranches(M, this.baseState(), this.outs, this.P(this.batter().pid), this.count, ctx);
      this.seq.push({ ti, cell });
      const br = brs[this.rng.pickIndex(brs.map((b) => b.p))];
      return this.applyBranch(br, { pitch: pitchInfo, kind: br.prof ? 'fair' : 'hitrun', sign, hitRun: true });
    }
    const stealing = sign.steal && this.stealRunner(sign.steal) ? sign.steal : null;
    const res = resolveAtPlate(M, cell, ti, countKey, stealing ? 'take' : (sign.approach || 'normal'), this.seq, this.rng, sign.look ?? null);
    this.seq.push({ ti, cell });
    pitchInfo.result = res.kind;
    if (res.kind === 'inplay') return this.resolveFair(res, pitchInfo, ctx, sign);

    const label = { ball: 'Ball', called: 'Called strike', swinging: 'Swinging strike', foul: 'Foul ball', hbp: 'Hit by pitch' }[res.kind];
    if (res.kind === 'ball') this.count.b++;
    else if (res.kind === 'called' || res.kind === 'swinging') this.count.s++;
    else if (res.kind === 'foul' && this.count.s < 2) this.count.s++;
    this.emit({ kind: 'pitch', pitch: pitchInfo, text: `${label} (${pitchInfo.name})`, count: { ...this.count } });

    if (res.kind === 'hbp') {
      this.emit({ kind: 'play', text: `${this.P(this.batter().pid).l} is hit by the pitch.` });
      return this.walkBatter('HBP');
    }
    // runners going: ball four makes it a walk; otherwise the throw decides it
    if (stealing && res.kind !== 'foul' && this.count.b < 4) {
      const runner = this.stealRunner(stealing);
      const sctx = { ...ctx, offspeed: type.cls !== 'F', slideStep: !!defense.slideStep };
      const base = stealing === 'double' ? 3 : stealing;
      const ps = stealing === 'double' ? clamp(stealProb(this.bases[1], 3, sctx) + 0.04, 0.05, 0.97) : stealProb(runner, base, sctx);
      const safe = this.rng.chance(ps);
      const strikeThree = this.count.s >= 3;
      if (strikeThree) { this.emit({ kind: 'play', text: `${this.P(this.batter().pid).l} strikes out.` }); this.outs++; }
      if (this.outs < 3) this.resolveSteal(stealing, safe, ps);
      if (this.over) return pitchInfo;
      if (strikeThree || this.outs >= 3) this.endPA('K');
      return pitchInfo;
    }
    // wild pitch or passed ball on pitches in the dirt
    if (res.kind !== 'foul' && cellV(cell) === -2 && this.bases.some(Boolean) && this.count.b < 4) {
      const catcher = this.P(this.fielders(ft)[2]);
      const cd = catcher.d && catcher.d[2] !== undefined ? catcher.d[2] : 50;
      const pwp = (type.key === 'KN' ? 0.11 : 0.035) * (1 - 0.01 * (cd - 50));
      if (this.rng.chance(pwp)) {
        const r = this.bases;
        const runs = r[2] ? [r[2]] : [];
        this.bases = [null, r[0], r[1]];
        this.emit({ kind: 'play', text: `${type.key === 'KN' || this.rng.chance(0.6) ? 'Wild pitch' : 'Passed ball'}! The runners move up.` });
        this.scoreRuns(runs);
        if (this.over) return pitchInfo;
      }
    }
    if (this.count.b >= 4) {
      this.emit({ kind: 'play', text: `${this.P(this.batter().pid).l} walks.` });
      this.walkBatter('BB');
      return pitchInfo;
    }
    if (this.count.s >= 3) {
      this.emit({ kind: 'play', text: `${this.P(this.batter().pid).l} strikes out ${res.kind === 'called' ? 'looking' : 'swinging'}.` });
      this.outs++;
      this.endPA('K');
    }
    return pitchInfo;
  },
  stealRunner(which) {
    if (which === 2) return !this.bases[1] ? this.bases[0] : null;
    if (which === 3) return !this.bases[2] ? this.bases[1] : null;
    if (which === 4) return this.bases[2];
    if (which === 'double') return this.bases[0] && this.bases[1] && !this.bases[2] ? this.bases[1] : null;
    return null;
  },
  walkBatter(result) {
    const w = forcedAdvance(this.baseState(), this.runnerObj(this.batter().pid));
    this.bases = w.bases;
    this.scoreRuns(w.scored);
    if (!this.over) this.endPA(result);
    return true;
  },

  resolveSteal(which, safe, ps) {
    const r = this.bases;
    const name = (x) => (x ? x.name : 'the runner');
    if (which === 2) {
      if (safe) { this.bases = [null, r[0], r[2]]; this.emit({ kind: 'play', text: `${name(r[0])} steals second!` }); }
      else { this.bases = [null, null, r[2]]; this.outs++; this.emit({ kind: 'play', text: `${name(r[0])} is thrown out stealing second.` }); }
    } else if (which === 3) {
      if (safe) { this.bases = [r[0], null, r[1]]; this.emit({ kind: 'play', text: `${name(r[1])} steals third!` }); }
      else { this.bases = [r[0], null, null]; this.outs++; this.emit({ kind: 'play', text: `${name(r[1])} is thrown out at third.` }); }
    } else if (which === 4) {
      if (safe) { const run = r[2]; this.bases = [r[0], r[1], null]; this.emit({ kind: 'play', text: `${name(run)} steals home!` }); this.scoreRuns([run]); }
      else { this.bases = [r[0], r[1], null]; this.outs++; this.emit({ kind: 'play', text: `${name(r[2])} is out at the plate.` }); }
    } else if (which === 'double') {
      if (safe) { this.bases = [null, r[0], r[1]]; this.emit({ kind: 'play', text: 'Double steal! Both runners are safe.' }); }
      else { this.bases = [null, r[0], null]; this.outs++; this.emit({ kind: 'play', text: `${name(r[1])} is thrown out at third on the double steal.` }); }
    }
  },

  resolveFair(res, pitchInfo, ctx, sign) {
    const M = this.matchup();
    const batterPl = this.P(this.batter().pid);
    ctx.gbTilt = (PITCH_TYPES[pitchInfo.type] && PITCH_TYPES[pitchInfo.type].gb) || 1;
    if (cellV(pitchInfo.cell) < 0) ctx.gbTilt *= 1.25;
    if (cellV(pitchInfo.cell) > 0) ctx.gbTilt *= 0.8;
    ctx.running = !!sign.runHit;
    const profs = profile(res.result, ctx);
    const prof = profs[this.rng.pickIndex(profs.map((p) => p.p))];
    const convs = conversions(res.result, prof, ctx);
    const conv = convs[this.rng.pickIndex(convs.map((c) => c.p))];
    // a send/hold call for the user's team on a big run
    const userBatting = this.isUser(this.half);
    const decisions = [];
    const probe = (kind, runner, ps) => {
      decisions.push({ kind, runner, ps });
      return autoSend(ps, this.outs, kind, { bigRun: this.bigRun(runner) });
    };
    advance(conv.category, prof, ctx, this.outs, this.baseState(), batterPl, probe);
    const ask = userBatting && decisions.find((d) => (d.kind === 'home-from-2nd' || d.kind === 'home-from-1st' || d.kind === 'tag-home')
      && this.bigRun(d.runner) && d.ps > 0.3 && d.ps < 0.92);
    const finish = (choice) => {
      const policy = (kind, runner, ps) => (ask && kind === ask.kind && runner === ask.runner ? choice
        : autoSend(ps, this.outs, kind, { bigRun: this.bigRun(runner) }));
      const brs = advance(conv.category, prof, ctx, this.outs, this.baseState(), batterPl, policy);
      const br = brs[this.rng.pickIndex(brs.map((b) => b.p))];
      br.category = conv.category;
      br.prof = prof;
      br.pa = conv.category;
      this.applyBranch(br, { pitch: pitchInfo, kind: 'fair', sign });
    };
    if (ask) {
      this.pending = {
        kind: 'send', side: this.half, runner: ask.runner.name, pSafe: ask.ps, what: ask.kind,
        text: ask.kind === 'tag-home' ? `Fly ball to ${fieldName(prof.field)}. Send ${ask.runner.name} home on the tag?`
          : `${conv.category === 'B2' ? 'Double' : 'Base hit'} to ${fieldName(prof.field)}. Send ${ask.runner.name} home?`,
        resolve: finish,
      };
      this.emit({ kind: 'pitch', pitch: pitchInfo, text: `In play (${pitchInfo.name})`, count: { ...this.count } });
      return pitchInfo;
    }
    this.emit({ kind: 'pitch', pitch: pitchInfo, text: `In play (${pitchInfo.name})`, count: { ...this.count }, quiet: true });
    finish(null);
    return pitchInfo;
  },

  answer(choice) {
    const p = this.pending;
    if (!p || !p.resolve) return;
    this.pending = null;
    this.emit({ kind: 'decision', text: choice ? `You send ${p.runner}.` : `You hold ${p.runner}.`, send: choice, pSafe: p.pSafe });
    p.resolve(!!choice);
  },

  // apply a resolved branch (fair ball, bunt, hit-and-run, IBB)
  applyBranch(br, meta) {
    const batterPid = this.batter().pid;
    const batterRunner = this.runnerObj(batterPid);
    const bases = br.bases.map((x) => (x && x.batter ? batterRunner : x));
    const scored = br.scored.map((x) => (x && x.batter ? batterRunner : x));
    const outsBefore = this.outs;
    this.outs += br.outs;
    this.bases = this.outs >= 3 ? [null, null, null] : bases;
    let text;
    const bname = this.P(batterPid).l;
    if (meta.kind === 'fair' || (br.category && meta.kind === 'hitrun' && br.prof)) {
      text = describeFair(bname, br.category, br.prof, br.note, scored.map((r) => r.name), outsBefore, this.outs);
      if (meta.kind === 'hitrun') text = 'Hit and run! ' + text;
    } else {
      text = cap(br.note || 'Play') + '.';
      if (meta.kind === 'bunt') text = `${bname}: ${text}`;
    }
    if (meta.pitch && meta.kind !== 'fair') this.emit({ kind: 'pitch', pitch: meta.pitch, text: meta.kind === 'bunt' ? 'Bunt attempt' : 'Hit and run', count: { ...this.count }, quiet: true });
    this.emit({ kind: 'play', text, category: br.category || br.pa, scored: scored.length, prof: br.prof || null });
    if (['B1', 'B2', 'B3', 'HR'].includes(br.category) || (br.note && /bunt single/.test(br.note))) this.hits[this.half] += 1;
    if (br.category === 'ROE') this.errors[1 - this.half] += 1;
    // runs: on a play that makes the third out, only time plays count
    const runsCount = this.outs >= 3 && /double play|force|ground|bunt/.test(br.note || '') ? [] : scored;
    this.scoreRuns(runsCount);
    if (this.over) return meta.pitch;
    if (br.sameBatter && this.outs < 3) {
      this.count = { ...br.count };
      return meta.pitch;
    }
    this.endPA(br.pa || br.category || 'OUT');
    return meta.pitch;
  },

  scoreRuns(runners) {
    if (!runners.length) return;
    const n = runners.length;
    this.score[this.half] += n;
    this.line[this.half][this.inning - 1] = (this.line[this.half][this.inning - 1] || 0) + n;
    this.emit({ kind: 'runs', n, text: `${joinNames(runners.map((r) => r.name))} ${n === 1 ? 'scores' : 'score'}.`, quiet: true });
    if (this.half === 1 && this.inning >= 9 && this.score[1] > this.score[0]) {
      this.emit({ kind: 'walkoff', text: 'Walk-off!' });
      this.endGame(1);
    }
  },

  endPA(result) {
    this.paEnded = true;
    this.lastPA = result;
    if (this.over) return;
    this.finishPA(this.outs >= 3);
    if (this.over) return;
    if (this.outs >= 3) this.nextHalf();
    if (!this.over) this.beginPA();
  },
  finishPA() {
    if (this._finished === this.paNo) return;
    this._finished = this.paNo;
    const bt = this.bat(), ft = this.fld();
    const b = this.batter();
    const ps = ft.pst[ft.pitcher];
    if (ps) {
      ps.bf += 1; ps.stint += 1;
      ps.faced[b.pid] = (ps.faced[b.pid] || this.tto(ft, b.pid)) + 1;
      if (ps.cold && ps.stint >= 2) ps.cold = false;
    }
    const ln = this.lines[b.pid] || (this.lines[b.pid] = [0, 0, 0, 0, 0, 0, 0]);
    ln[0]++;
    const r = this.lastPA;
    if (!['BB', 'IBB', 'HBP', 'BUNT'].includes(r)) ln[1]++;
    if (['B1', 'B2', 'B3', 'HR'].includes(r)) ln[2]++;
    if (r === 'HR') ln[3]++;
    if (r === 'BB' || r === 'IBB') ln[4]++;
    if (r === 'K') ln[5]++;
    bt.slot = (bt.slot + 1) % 9;
    this.paNo++;
    this.emit({ kind: 'paEnd', result: r });
  },

  // ---------------------------------------------------------------- manager moves
  ibb() {
    if (this.over || this.pending) return;
    const ft = this.fld();
    if (!this.paStarted) { this.paStarted = true; this.emit({ kind: 'firstPitch', sign: {}, defense: { ibb: true } }); }
    const br = ibbBranches(this.baseState())[0];
    this.emit({ kind: 'move', side: ft.side, text: `${ft.nick} intentionally walk ${this.P(this.batter().pid).l}.`, move: 'ibb' });
    const pst = ft.pst[ft.pitcher];
    if (!this.rules.autoIBB) pst.pitches += 4 - this.count.b;
    const batterRunner = this.runnerObj(this.batter().pid);
    this.bases = br.bases.map((x) => (x && x.batter ? batterRunner : x));
    this.scoreRuns(br.scored);
    if (this.over) return;
    this.endPA('IBB');
  },
  pickoff(base) {
    const ft = this.fld();
    const runner = this.bases[base - 1];
    if (!runner || this.over) return null;
    this.pickoffsThisPA++;
    const pit = this.pitcherObj();
    if (this.rules.limitPO && this.pickoffsThisPA > 2) {
      // third disengagement must get the runner or it's a balk
      const got = this.rng.chance(0.08);
      if (!got) {
        this.emit({ kind: 'play', text: 'Balk: a third disengagement without an out. The runners move up.' });
        this.advanceAllRunners();
        return 'balk';
      }
    }
    let p = 0.022 + (pit.t === 'L' && base === 1 ? 0.025 : 0) + 0.0008 * ((runner.spd || 50) - 50);
    if (this.rng.chance(p)) {
      this.bases[base - 1] = null;
      this.outs++;
      this.emit({ kind: 'play', text: `${runner.name} is picked off ${['first', 'second', 'third'][base - 1]}!` });
      if (this.outs >= 3) { this.finishPA(); this.nextHalf(); this.beginPA(); }
      return 'out';
    }
    if (this.rng.chance(0.006)) {
      this.emit({ kind: 'play', text: 'Balk! The runners move up.' });
      this.advanceAllRunners();
      return 'balk';
    }
    this.emit({ kind: 'note', text: `Throw over to ${['first', 'second', 'third'][base - 1]}. ${runner.name} gets back.` });
    return 'safe';
  },
  advanceAllRunners() {
    const r = this.bases;
    const runs = r[2] ? [r[2]] : [];
    this.bases = [null, r[0], r[1]];
    this.scoreRuns(runs);
  },
  visit() {
    const ft = this.fld();
    const pid = ft.pitcher;
    const n = (ft.visits[pid] || 0) + 1;
    if (n >= 2) return { ok: false, reason: 'A second visit to the same pitcher in an inning means he has to come out.' };
    ft.visits[pid] = n;
    const ps = ft.pst[pid];
    ps.pitches = Math.max(0, ps.pitches - 4); // a breather
    this.emit({ kind: 'move', side: ft.side, text: `Mound visit for ${this.P(pid).l}.`, move: 'visit' });
    this._mkey = null;
    return { ok: true };
  },
  warm(pid) {
    const ft = this.teams[this.fldSideFor(pid)];
    if (!ft.pen.includes(pid)) return;
    if (ft.warming[pid] === undefined) {
      ft.warming[pid] = 0;
      this.emit({ kind: 'move', side: ft.side, text: `${this.P(pid).l} starts warming up in the ${ft.nick} bullpen.`, move: 'warm', quiet: !this.isUser(ft.side) });
    }
  },
  fldSideFor(pid) { return this.teams[0].pen.includes(pid) ? 0 : 1; },
  canChangePitcher(side) {
    const t = this.teams[side];
    const pid = t.pitcher;
    if (!pid) return { ok: true };
    if (this.rules.three && side !== this.half) {
      const ps = t.pst[pid];
      const enteredThisHalf = ps && ps.entered && ps.entered.inning === this.inning && ps.entered.half === this.half && ps.stint < 99;
      if (enteredThisHalf && ps.stint < 3 && this.outs < 3) return { ok: false, reason: 'Three-batter minimum: he has to face three hitters or finish the inning.' };
    }
    return { ok: true };
  },
  changePitcher(pid, opts = {}) {
    const side = opts.side !== undefined ? opts.side : 1 - this.half;
    const t = this.teams[side];
    if (!t.pen.includes(pid)) return { ok: false, reason: 'Not available.' };
    if (!opts.force) {
      const can = this.canChangePitcher(side);
      if (!can.ok && t.pitcher && !t.removed.has(t.pitcher)) return can;
    }
    const old = t.pitcher;
    if (old) t.removed.add(old);
    t.pen = t.pen.filter((p) => p !== pid);
    const warmed = t.warming[pid] !== undefined && t.warming[pid] >= 0.9;
    const betweenInnings = side !== this.half && !this.paStarted && this.paNo === this.halfStartPA;
    delete t.warming[pid];
    t.pitcher = pid;
    t.pst[pid] = { pitches: 0, bf: 0, faced: {}, entered: { inning: this.inning, half: this.half }, cold: !(warmed || betweenInnings), stint: 0 };
    if (!t.dh) {
      // the new pitcher bats in the old pitcher's spot (or a double switch)
      let slot = t.lineup.findIndex((x) => x.pid === old);
      if (slot < 0) slot = t.lineup.findIndex((x) => x.needPitcher || x.pos === 11 || x.pos === 12);
      if (opts.doubleSwitch) {
        const ds = opts.doubleSwitch; // {slot, benchPid}
        const removedPl = t.lineup[ds.slot];
        const pos = removedPl.pos;
        t.removed.add(removedPl.pid);
        t.lineup[ds.slot] = { pid, pos: 1 };
        if (slot >= 0) t.lineup[slot] = { pid: ds.benchPid, pos };
        t.bench = t.bench.filter((p) => p !== ds.benchPid);
        this.emit({ kind: 'move', side, text: `Double switch: ${this.P(pid).l} pitches and bats ${ordinal(ds.slot + 1)}; ${this.P(ds.benchPid).l} takes over at ${POS_ABBR[pos]}.`, move: 'pitch' });
      } else if (slot >= 0) {
        const prev = t.lineup[slot].pid;
        if (prev !== old) t.removed.add(prev);
        t.lineup[slot] = { pid, pos: 1 };
      }
    }
    if (!opts.doubleSwitch) {
      const cold = t.pst[pid].cold;
      this.emit({ kind: 'move', side, text: old ? `Pitching change: ${this.P(pid).n} replaces ${this.P(old).l}${cold ? ' (not fully warm)' : ''}.` : `${this.P(pid).n} takes the mound for the ${t.nick}.`, move: 'pitch', pid });
    }
    if (this.pending && this.pending.kind === 'needPitcher' && this.pending.side === side) this.pending = null;
    this._mkey = null;
    return { ok: true };
  },
  lastHalfStartIdx() {
    for (let i = this.log.length - 1; i >= 0; i--) {
      if (this.log[i].kind === 'halfStart') return i;
      if (this.log[i].kind === 'pitch') return -1;
    }
    return -1;
  },
  pinchHit(pid) {
    const t = this.bat();
    if (!t.bench.includes(pid) || this.paStarted) return { ok: false, reason: 'Pinch hitters come in before the first pitch.' };
    const slot = t.slot;
    const old = t.lineup[slot].pid;
    t.removed.add(old);
    t.bench = t.bench.filter((p) => p !== pid);
    const wasPitcher = old === t.pitcher;
    t.lineup[slot] = { pid, pos: 11 };
    this.emit({ kind: 'move', side: t.side, text: `${this.P(pid).n} pinch-hits for ${this.P(old).l}.`, move: 'ph', pid });
    if (wasPitcher) t.pitcherOutAfterHalf = true;
    this._mkey = null;
    return { ok: true };
  },
  pinchRun(base, pid) {
    const t = this.bat();
    const runner = this.bases[base - 1];
    if (!runner || !t.bench.includes(pid)) return { ok: false, reason: 'Not available.' };
    const slot = t.lineup.findIndex((x) => x.pid === runner.pid);
    t.removed.add(runner.pid);
    t.bench = t.bench.filter((p) => p !== pid);
    if (slot >= 0) t.lineup[slot] = { pid, pos: 12 };
    this.bases[base - 1] = { ...this.runnerObj(pid), resp: runner.resp };
    this.emit({ kind: 'move', side: t.side, text: `${this.P(pid).n} pinch-runs for ${runner.name}.`, move: 'pr', pid });
    return { ok: true };
  },
  defSub(side, slot, pid, pos) {
    const t = this.teams[side];
    if (!t.bench.includes(pid)) return { ok: false, reason: 'Not available.' };
    const old = t.lineup[slot];
    t.removed.add(old.pid);
    t.bench = t.bench.filter((p) => p !== pid);
    t.lineup[slot] = { pid, pos: pos || old.pos };
    this.emit({ kind: 'move', side, text: `Defensive change: ${this.P(pid).n} replaces ${this.P(old.pid).l} at ${POS_ABBR[pos || old.pos]}.`, move: 'def', pid });
    this._mkey = null;
    return { ok: true };
  },
  movePos(side, slot, pos) {
    const t = this.teams[side];
    const other = t.lineup.findIndex((x) => x.pos === pos);
    const mine = t.lineup[slot].pos;
    if (other >= 0) t.lineup[other].pos = mine;
    t.lineup[slot].pos = pos;
    this.emit({ kind: 'move', side, text: `${this.P(t.lineup[slot].pid).l} moves to ${POS_ABBR[pos]}.`, move: 'pos' });
  },
  setAlign(side, align) {
    const t = this.teams[side];
    const a = { ...t.align, ...align };
    if (!this.rules.shift) a.shift = false;
    t.align = a;
  },
};

function cellIndexSafe(h, v) { return (v + 2) * 5 + (h + 2); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

Object.assign(exports, { createGame, ordinal, POS_ABBR });
});
__def("engine/model.js", function (exports) {
// Player ratings -> plate appearance probabilities.
// Batter and pitcher season rates are combined with the odds-ratio method
// against that season's league, then adjusted for handedness, fatigue and how
// many times the batter has seen this pitcher today.

const RATE = ['K', 'BB', 'HBP', 'HR', 'B1', 'B2', 'B3'];
const OUTCOMES = ['K', 'BB', 'HBP', 'HR', 'B1', 'B2', 'B3', 'OUT'];
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

function battingSide(bats, throws) {
  if (bats === 'B') return throws === 'L' ? 'R' : 'L';
  return bats === 'L' ? 'L' : 'R';
}

function oddsRatio(b, p, l) {
  b = clamp(b, 1e-4, 0.95); p = clamp(p, 1e-4, 0.95); l = clamp(l, 1e-4, 0.95);
  const o = (b / (1 - b)) * (p / (1 - p)) / (l / (1 - l));
  return o / (1 + o);
}

// Fatigue 0 (fresh) .. 1 (spent) for a pitcher given today's pitch count.
function fatigue(pitcher, pitches, energy, cold) {
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
function paTarget(batter, pitcher, ctx) {
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
function batterGrades(batter, lg) {
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

function eyeRating(batter, lg) {
  const L = lg.pos;
  return clamp(50 + 26 * (batter.h[1] / L.bb - 1) - 10 * (batter.h[0] / L.k - 1), 20, 80);
}

Object.assign(exports, { battingSide, fatigue, paTarget, batterGrades, eyeRating, RATE, OUTCOMES });
});
__def("engine/pitch.js", function (exports) {
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

const { paTarget, eyeRating, battingSide } = __req("engine/model.js");
const { hashString } = __req("engine/rng.js");

const PITCH_TYPES = {
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
const cellIndex = (h, v) => (v + 2) * 5 + (h + 2);
const cellH = (i) => (i % 5) - 2;
const cellV = (i) => Math.floor(i / 5) - 2;
const inZone = (i) => Math.abs(cellH(i)) <= 1 && Math.abs(cellV(i)) <= 1;

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
const CELL_CLASS = CLS;
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
// The hitter looks for a pitch in one part of the zone (the 3x3 block around
// the cell he sits on). If it comes there he's on time; anywhere else he's
// late or fooled. Tuned so a blind guess is worth nothing on average
// (tests/look.mjs); reading the pitcher's tendencies pays.
const LOOK = { whiff: 0.25, dmg: 0.25, out: 1.45 };
const inLook = (cell, look) => Math.abs(cellH(cell) - cellH(look)) <= 1 && Math.abs(cellV(cell) - cellV(look)) <= 1;
// catcher's call: share of pitches aimed in the zone, and fastball lean, by count
const ZONE_AIM = {
  '0-0': 0.60, '1-0': 0.66, '2-0': 0.75, '3-0': 0.86, '0-1': 0.52, '1-1': 0.57,
  '2-1': 0.64, '3-1': 0.75, '0-2': 0.30, '1-2': 0.38, '2-2': 0.48, '3-2': 0.66,
};
const FB_LEAN = {
  '0-0': 1.0, '1-0': 1.15, '2-0': 1.35, '3-0': 1.6, '0-1': 0.9, '1-1': 0.95,
  '2-1': 1.1, '3-1': 1.35, '0-2': 0.75, '1-2': 0.8, '2-2': 0.85, '3-2': 1.1,
};
const COUNTS = [];
for (let b = 0; b <= 3; b++) for (let s = 0; s <= 2; s++) COUNTS.push(`${b}-${s}`);

// Outcome categories for a fair ball
const BIP = ['HR', 'B3', 'B2', 'B1', 'OUT'];
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
function scatterMatrix(command) {
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

// Share of a typical hitter's swings that come in each look region, from a
// league-average pitch mix at an even count. The look bonus is weighed
// against it so that guessing blind evens out.
const LOOK_SHARE = (() => {
  const S = scatterMatrix(0.47);
  const act = new Float64Array(25);
  for (const [cls, w] of [['F', 0.55], ['B', 0.3], ['O', 0.15]]) {
    const aim = AIM[cls][0];
    for (let t = 0; t < 25; t++) {
      const p = 0.5 * aim.zone[t] + 0.5 * aim.out[t];
      for (let a = 0; a < 25; a++) act[a] += w * p * S[t * 25 + a];
    }
  }
  const sw = Array.from(act, (p, i) => p * SWING[CLS[i]]);
  const tot = sw.reduce((a, b) => a + b, 0);
  const out = {};
  for (let v = -1; v <= 1; v++) {
    for (let h = -1; h <= 1; h++) {
      const look = cellIndex(h, v);
      out[look] = sw.reduce((a, x, i) => a + (inLook(i, look) ? x : 0), 0) / tot;
    }
  }
  return out;
})();

function commandOf(pitcher, tired, typeKey) {
  const ctl = pitcher.p ? pitcher.p.ctl : 40;
  let c = 0.47 + 0.0055 * (ctl - 50) - 0.12 * tired;
  if (typeKey === 'KN') c -= 0.08;
  return Math.max(0.22, Math.min(0.64, c));
}

// Batter zone map: damage multipliers per cell, estimated from power and handedness
function zoneMap(batter) {
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
function buildMatchup(batter, pitcher, ctx) {
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
  M.pitchProbs = function (cell, ti, count, approach, seq, look = null) {
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
    if (look !== null && look !== undefined && approach !== 'take') {
      // a wider look pays less when it's right and costs more when it's wrong
      const q = LOOK_SHARE[look] ?? 0.4;
      const k = q / (1 - q);
      if (inLook(cell, look)) { whiff *= 1 - LOOK.whiff; dmg *= 1 + LOOK.dmg; }
      else { whiff *= 1 + LOOK.whiff * k * LOOK.out; dmg *= Math.max(0.45, 1 - LOOK.dmg * k * LOOK.out); }
    }
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
function distFromVector(v) {
  return { K: v[0], BB: v[1], HBP: v[2], HR: v[3], B3: v[4], B2: v[5], B1: v[6], OUT: v[7], pitches: v[8] };
}

// PA distribution from a count, optionally with a different approach policy
function paDist(M, b, s, approachKey) {
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
function catcherCall(M, count, rng) {
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
function deliver(M, ti, target, rng, extraWild = 0) {
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
function resolveAtPlate(M, cell, ti, count, approach, seq, rng, look = null) {
  const r = M.pitchProbs(cell, ti, count, approach, seq, look);
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
function buntContact(M, cell, skill) {
  const c = CLS[cell];
  const base = [0.92, 0.88, 0.8, 0.55, 0.42, 0.2][c];
  return Math.max(0.1, Math.min(0.97, base + 0.006 * (skill - 50)));
}

Object.assign(exports, { scatterMatrix, commandOf, zoneMap, buildMatchup, distFromVector, paDist, catcherCall, deliver, resolveAtPlate, buntContact, PITCH_TYPES, cellIndex, cellH, cellV, inZone, CELL_CLASS, LOOK, inLook, COUNTS, BIP });
});
__def("engine/rng.js", function (exports) {
// Seeded random numbers. The same seed and the same calls give the same game,
// so two managers who make identical calls in the Daily see identical results.

function hashString(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

function makeRng(seed) {
  let [a, b, c, d] = hashString(String(seed));
  function next() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  }
  for (let i = 0; i < 12; i++) next();
  return {
    next,
    chance(p) { return next() < p; },
    // pick an index from an array of weights
    pickIndex(weights) {
      let total = 0;
      for (const w of weights) total += w;
      let x = next() * total;
      for (let i = 0; i < weights.length; i++) {
        x -= weights[i];
        if (x < 0) return i;
      }
      return weights.length - 1;
    },
  };
}

Object.assign(exports, { hashString, makeRng });
});
__def("engine/tactics.js", function (exports) {
// Manager tactics as weighted branches. Live play samples a branch; the grader
// sums over them. A branch is the state right after the tactic resolves:
// { p, outs (added), bases: [r1,r2,r3], scored: [...], pa: result | null,
//   sameBatter: bool, count: {b,s} (when sameBatter), note }

const { fairBallBranches, autoSend } = __req("engine/bip.js");

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const BATTER = { batter: true };

// batter to first, forced runners move up
function forcedAdvance([r1, r2, r3], B = BATTER) {
  if (!r1) return { bases: [B, r2, r3], scored: [] };
  if (!r2) return { bases: [B, r1, r3], scored: [] };
  if (!r3) return { bases: [B, r1, r2], scored: [] };
  return { bases: [B, r1, r2], scored: [r3] };
}
// every runner moves up one base, batter's spot given
const allUp = ([r1, r2, r3], first) => ({ bases: [first, r1, r2], scored: r3 ? [r3] : [] });

// Strike added to the count on a pitch where the PA continues.
function strikeBranch(p, count, bases, outsAdded, note) {
  const c = { b: count.b, s: count.s + 1 };
  if (c.s >= 3) return { p, outs: outsAdded + 1, bases, scored: [], pa: 'K', sameBatter: false, note: note + '; strike three' };
  return { p, outs: outsAdded, bases, scored: [], pa: null, sameBatter: true, count: c, note };
}

// ---------------------------------------------------------------- steals
function stealProb(runner, base, ctx) {
  const lgp = (ctx.lg && ctx.lg.sbpct) || 0.68;
  const spd = runner.spd || 50;
  const skill = runner.stl || lgp;
  let p = 0.4 * lgp + 0.6 * skill + 0.002 * (spd - 50) - 0.005 * ((ctx.catcherArm || 50) - 50);
  if (base === 2 && ctx.pitcherThrows === 'L') p -= 0.07;
  if (base === 3) p -= 0.02;
  if (base === 4) p = 0.12 + 0.004 * (spd - 50);
  if (ctx.offspeed) p += 0.05;
  if (ctx.pitchout) p -= 0.32;
  if (ctx.slideStep) p -= 0.06;
  if (ctx.bigBases) p += 0.05;
  if (ctx.pickoffs) p -= 0.02 * ctx.pickoffs;
  return clamp(p, 0.05, 0.97);
}

// which: 2 (runner on first), 3 (runner on second), 4 (runner on third), 'double'.
// The batter takes; zoneP is the chance the pitch is a strike.
function stealBranches(bases, which, ctx, count, zoneP) {
  const [r1, r2, r3] = bases;
  const out = [];
  const nm = (r) => (r && r.name) || 'the runner';
  const plays = [];
  if (which === 2 && r1) {
    const ps = stealProb(r1, 2, ctx);
    plays.push([ps, 0, [null, r1, r3], [], `${nm(r1)} steals second`]);
    plays.push([1 - ps, 1, [null, null, r3], [], `${nm(r1)} is caught stealing`]);
  } else if (which === 3 && r2) {
    const ps = stealProb(r2, 3, ctx);
    plays.push([ps, 0, [r1, null, r2], [], `${nm(r2)} steals third`]);
    plays.push([1 - ps, 1, [r1, null, null], [], `${nm(r2)} is caught stealing third`]);
  } else if (which === 4 && r3) {
    const ps = stealProb(r3, 4, ctx);
    plays.push([ps, 0, [r1, r2, null], [r3], `${nm(r3)} steals home`]);
    plays.push([1 - ps, 1, [r1, r2, null], [], `${nm(r3)} is out at the plate`]);
  } else if (which === 'double' && r1 && r2) {
    const ps = clamp(stealProb(r2, 3, ctx) - 0.04, 0.05, 0.95);
    plays.push([ps, 0, [null, r1, r2], [], 'double steal']);
    plays.push([1 - ps, 1, [null, r1, null], [], 'the lead runner is thrown out at third']);
  }
  for (const [ps, o, nb, sc, note] of plays) {
    // the pitch itself: strike or ball
    for (const [pp, isStrike] of [[zoneP, true], [1 - zoneP, false]]) {
      const p = ps * pp;
      if (p <= 1e-9) continue;
      if (isStrike) {
        const br = strikeBranch(p, count, nb, o, note);
        br.scored = sc;
        out.push(br);
      } else if (count.b + 1 >= 4) {
        const w = forcedAdvance(nb);
        out.push({ p, outs: o, bases: w.bases, scored: [...sc, ...w.scored], pa: 'BB', sameBatter: false, note: note + '; ball four' });
      } else out.push({ p, outs: o, bases: nb, scored: sc, pa: null, sameBatter: true, count: { b: count.b + 1, s: count.s }, note });
    }
  }
  return out;
}

// ---------------------------------------------------------------- bunts
// kind: 'sac' | 'squeeze' | 'safety' | 'drag'
function buntBranches(kind, bases, outs, batter, ctx, count) {
  const [r1, r2, r3] = bases;
  const skill = batter.bnt || 45;
  const spd = batter.spd || 50;
  const corners = !!(ctx.align && ctx.align.inf === 'corners');
  let contact = clamp(0.8 + 0.006 * (skill - 50) - 0.004 * ((ctx.pitcherStuff || 50) - 50), 0.4, 0.95);
  if (ctx.pitchout) contact = 0.12;
  const foulShare = clamp(0.3 - 0.004 * (skill - 50), 0.1, 0.45) * (kind === 'squeeze' ? 0.8 : 1);
  const fair = contact * (1 - foulShare);
  const foul = contact * foulShare;
  const miss = 1 - contact;
  const out = [];
  const add = (p, o, nb, scored, note) => {
    if (p > 1e-9) out.push({ p, outs: o, bases: nb, scored, pa: 'BUNT', sameBatter: false, note });
  };

  if (kind === 'squeeze' && r3) {
    const score = clamp(0.88 + 0.003 * (skill - 50) - (r1 && r2 ? 0.3 : 0), 0.4, 0.97);
    add(fair * score * 0.85, 1, [null, r1, r2], [r3], 'squeeze bunt, the run scores');
    add(fair * score * 0.15, 0, [BATTER, r1, r2], [r3], 'squeeze bunt, everyone is safe');
    add(fair * (1 - score), 1, [BATTER, r1, r2], [], 'squeeze bunt, the runner is out at the plate');
    // missed: the runner is hung out to dry
    out.push(strikeBranch(miss * 0.8, count, [r1, r2, null], 1, 'missed the squeeze, the runner is tagged out'));
    out.push(strikeBranch(miss * 0.2, count, bases, 0, 'missed the squeeze, the runner gets back'));
    out.push(strikeBranch(foul, count, bases, 0, 'squeeze bunt fouled off'));
    return out.filter((b) => b.p > 1e-9);
  }
  if (kind === 'safety' && r3) {
    const goes = clamp(0.62 + 0.006 * ((r3.spd || 50) - 50), 0.35, 0.85);
    add(fair * goes, 1, [null, r1, r2], [r3], 'safety squeeze, the run scores');
    add(fair * (1 - goes) * 0.6, 1, r2 ? [r1, r2, r3] : [null, r1, r3], [], 'safety squeeze, the runner holds');
    add(fair * (1 - goes) * 0.4, 1, [BATTER, r1, r2], [], 'safety squeeze, the runner is thrown out at home');
    out.push(strikeBranch(miss + foul, count, bases, 0, 'bunt attempt missed'));
    return out.filter((b) => b.p > 1e-9);
  }
  if (kind === 'drag') {
    // bunting for a hit on the move is harder to get down, and the defense is waiting late
    const dFair = fair * 0.8;
    const hit = clamp(0.24 + 0.011 * (spd - 50) + 0.002 * (skill - 50) - (corners ? 0.12 : 0) - (ctx.lateClose ? 0.05 : 0), 0.05, 0.55);
    const up = allUp(bases, BATTER);
    add(dFair * hit, 0, up.bases, up.scored, 'bunt single');
    const up2 = allUp(bases, null);
    add(dFair * (1 - hit) * 0.88, 1, up2.bases, outs < 2 ? up2.scored : [], 'bunt, thrown out at first');
    add(dFair * (1 - hit) * 0.12, 1, bases, [], 'bunt popped up');
    out.push(strikeBranch(miss + foul + (fair - dFair), count, bases, 0, 'bunt attempt fouled off'));
    return out.filter((b) => b.p > 1e-9);
  }
  // sacrifice
  const succ = clamp(0.68 + 0.005 * (skill - 50) - (corners ? 0.1 : 0), 0.35, 0.88);
  const hit = clamp(0.05 + 0.004 * (spd - 50), 0.01, 0.15);
  const forceLead = clamp(0.15 - 0.004 * (skill - 50) + (corners ? 0.1 : 0), 0.05, 0.35);
  const pop = clamp(1 - succ - hit - forceLead, 0.02, 0.2);
  const tot = succ + hit + forceLead + pop;
  const loaded = !!(r1 && r2 && r3);
  const sacBases = loaded ? [null, r1, r2] : r3 ? [null, r1 || r2, r3] : [null, r1, r2];
  add(fair * succ / tot, 1, sacBases, loaded ? [r3] : [], 'sacrifice bunt, the runners move up');
  const single = allUp(bases, BATTER);
  add(fair * hit / tot, 0, single.bases, single.scored, 'bunt single');
  let fc;
  if (r1 && r2 && r3) fc = [BATTER, r1, r2];
  else if (r1 && r2) fc = [BATTER, r1, null];
  else if (r1) fc = [BATTER, null, r3];
  else if (r2) fc = [BATTER, null, r3];
  else fc = [null, null, r3];
  add(fair * forceLead / tot, 1, fc, [], r1 || r2 ? 'the lead runner is cut down on the bunt' : 'bunt, thrown out at first');
  add(fair * pop / tot, 1, bases, [], 'bunt popped up');
  out.push(strikeBranch(miss + foul, count, bases, 0, 'bunt attempt missed'));
  return out.filter((b) => b.p > 1e-9);
}

// ---------------------------------------------------------------- hit and run
function hitAndRunBranches(M, bases, outs, batter, count, ctx) {
  const [r1, r2, r3] = bases;
  const key = `${count.b}-${count.s}`;
  let contact = 0, foul = 0;
  const bip = new Float64Array(5);
  for (const [ti, { p, actual }] of M.autoActual(key).entries()) {
    for (let cell = 0; cell < 25; cell++) {
      const w = p * actual[cell];
      if (w < 1e-9) continue;
      const r = M.pitchProbs(cell, ti, key, 'protect', null);
      const f = Math.min(0.85, 0.52 + (count.s === 2 ? 0.06 : 0));
      contact += w * r.contact;
      foul += w * r.contact * f;
      const d = M.bipDist(r.dmg * 0.85);
      for (let i = 0; i < 5; i++) bip[i] += w * r.contact * (1 - f) * d[i];
    }
  }
  const out = [];
  const whiff = 1 - contact;
  const ps = Math.max(0.05, stealProb(r1, 2, ctx) - 0.06);
  if (count.s + 1 >= 3) {
    out.push({ p: whiff * ps, outs: 1, bases: [null, r1, r3], scored: [], pa: 'K', sameBatter: false, note: 'strikeout, but the runner steals second' });
    out.push({ p: whiff * (1 - ps), outs: 2, bases: [null, null, r3], scored: [], pa: 'K', sameBatter: false, note: 'strike him out, throw him out' });
  } else {
    const c = { b: count.b, s: count.s + 1 };
    out.push({ p: whiff * ps, outs: 0, bases: [null, r1, r3], scored: [], pa: null, sameBatter: true, count: c, note: 'swing and a miss, the runner steals second' });
    out.push({ p: whiff * (1 - ps), outs: 1, bases: [null, null, r3], scored: [], pa: null, sameBatter: true, count: c, note: 'swing and a miss, the runner is thrown out' });
  }
  out.push({ p: foul, outs: 0, bases, scored: [], pa: null, sameBatter: true, count: { b: count.b, s: Math.min(2, count.s + 1) }, note: 'fouled off, the runner returns' });
  const cats = ['HR', 'B3', 'B2', 'B1', 'OUT'];
  const policy = (kind, runner, pSafe) => autoSend(pSafe, outs, kind, ctx);
  cats.forEach((cat, i) => {
    if (bip[i] <= 1e-9) return;
    for (const br of fairBallBranches(cat, { ...ctx, running: true }, outs, bases, batter, policy)) {
      out.push({ p: bip[i] * br.p, outs: br.outs, bases: br.bases, scored: br.scored, pa: br.category, sameBatter: false, note: br.note, prof: br.prof, category: br.category });
    }
  });
  return out;
}

// ---------------------------------------------------------------- intentional walk
function ibbBranches(bases) {
  const w = forcedAdvance(bases);
  return [{ p: 1, outs: 0, bases: w.bases, scored: w.scored, pa: 'IBB', sameBatter: false, note: 'intentional walk' }];
}

Object.assign(exports, { forcedAdvance, stealProb, stealBranches, buntBranches, hitAndRunBranches, ibbBranches });
});
__def("engine/text.js", function (exports) {
// Plain-English play descriptions for simulated plays.

const FIELD = { 1: 'the pitcher', 2: 'the catcher', 3: 'first', 4: 'second', 5: 'third', 6: 'short', 7: 'left', 8: 'center', 9: 'right' };
const FIELDER = { 1: 'pitcher', 2: 'catcher', 3: 'first baseman', 4: 'second baseman', 5: 'third baseman', 6: 'shortstop', 7: 'left fielder', 8: 'center fielder', 9: 'right fielder' };
const GAP = { 7: 'left', 8: 'center', 9: 'right' };

const fieldName = (pos) => FIELD[pos] || '';
const fielderName = (pos) => FIELDER[pos] || 'fielder';

function joinNames(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// category: HR B3 B2 B1 OUT ROE; prof: {bb, field, depth}; note from the branch
function describeFair(batterName, category, prof, note, scoredNames, outsBefore, outsAfter) {
  const f = prof ? prof.field : 8;
  const deep = prof && prof.depth === 'deep';
  let s;
  switch (category) {
    case 'HR': {
      const n = scoredNames.length;
      const kind = n >= 4 ? 'a grand slam' : n === 3 ? 'a three-run homer' : n === 2 ? 'a two-run homer' : 'a solo homer';
      s = `${batterName} hits ${kind} to ${deep || f >= 7 ? (GAP[f] || 'left') : 'left'}`;
      return s + '.';
    }
    case 'B3': s = `${batterName} triples to ${GAP[f] || 'right'}`; break;
    case 'B2': s = prof && prof.depth === 'line' ? `${batterName} doubles down the line` : `${batterName} doubles to ${deep ? 'deep ' : ''}${GAP[f] || 'left'}`; break;
    case 'B1':
      if (prof && prof.bb === 'G' && f <= 6) s = `${batterName} singles through the infield`;
      else if (prof && prof.bb === 'F') s = `${batterName} bloops a single to ${GAP[f] || 'center'}`;
      else s = `${batterName} singles to ${GAP[f] || 'center'}`;
      break;
    case 'ROE': s = `${batterName} reaches on an error by the ${fielderName(f)}`; break;
    default: {
      const bb = prof ? prof.bb : 'G';
      if (note && note.includes('double play') && bb === 'G') s = `${batterName} grounds into a double play`;
      else if (note && note.includes('double play') && bb === 'L') s = `${batterName} lines into a double play`;
      else if (note && note.includes('double play')) s = `${batterName} flies into a double play`;
      else if (bb === 'G') s = note && note.includes('force') ? `${batterName} grounds into a force out` : `${batterName} grounds out to ${FIELD[f]}`;
      else if (bb === 'L') s = `${batterName} lines out to ${FIELD[f]}`;
      else if (bb === 'P') s = `${batterName} pops out to ${FIELD[f]}`;
      else if (note && note.includes('sacrifice')) s = `${batterName} hits a sacrifice fly to ${FIELD[f]}`;
      else s = `${batterName} flies out to ${deep ? 'deep ' : ''}${FIELD[f]}`;
    }
  }
  const extras = [];
  if (note && /thrown out at third/.test(note)) extras.push('a runner is thrown out at third');
  if (note && /out at the plate/.test(note)) extras.push('a runner is thrown out at the plate');
  if (note && /takes second on the throw/.test(note)) extras.push('he takes second on the throw');
  if (note && /tags to third/.test(note)) extras.push('the runner tags up to third');
  if (scoredNames.length && category !== 'HR') extras.push(`${joinNames(scoredNames)} ${scoredNames.length === 1 ? 'scores' : 'score'}`);
  return s + (extras.length ? '; ' + extras.join('; ') : '') + '.';
}

const PITCH_WORD = { ball: 'Ball', called: 'Called strike', swinging: 'Swinging strike', foul: 'Foul', hbp: 'Hit by pitch', inplay: 'In play' };

Object.assign(exports, { joinNames, describeFair, fieldName, fielderName, PITCH_WORD });
});
__def("engine/wp.js", function (exports) {
// Exact win probability for the 9th inning and later.
//
// For the batting team, a Markov chain over (outs, bases, lineup slot) gives
// the distribution of runs still to score this half inning. Each batter's plate
// appearance distribution comes from the matchup model; advancement comes from
// the same batted-ball code used in live play, with average runners. The next
// half inning and extra innings follow from the same tables.

const { paTarget } = __req("engine/model.js");
const { fairBallBranches, autoSend, ALIGN_DEFAULT } = __req("engine/bip.js");

const MAXR = 12;
const TYPES = ['K', 'BB', 'HBP', 'HR', 'B3', 'B2', 'B1', 'OUT'];
const AVG = { spd: 50 };

const maskOf = (bases) => (bases[0] ? 1 : 0) | (bases[1] ? 2 : 0) | (bases[2] ? 4 : 0);
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
function inningEndFix(outs, br) {
  if (outs + br.outs >= 3 && br.note && /double play|force|ground/.test(br.note)) return { ...br, scored: [] };
  return br;
}

// Transition tables for anonymous runners: TR[outs][mask][type] -> [[p,o,m,r]...]
const TR_CACHE = new Map();
function transitions(opts = {}) {
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
function halfTable(dists, TR) {
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

function runDist(R, outs, mask, slot) {
  const b = idx(outs, mask, slot % 9);
  return R.subarray(b, b + MAXR);
}

const tailGt = (d, k) => { let s = 0; for (let i = k + 1; i < d.length; i++) s += d[i]; return k < 0 ? 1 : s; };
const at = (d, k) => (k >= 0 && k < d.length ? d[k] : 0);

// Home win probability in extra innings, tied, start of an inning.
function extraTied(distV, distH) {
  let A = 0, B = 0;
  for (let r = 0; r < MAXR; r++) {
    A += distV[r] * tailGt(distH, r);
    B += distV[r] * distH[r];
  }
  return A / Math.max(1e-9, 1 - B);
}

// Average fresh-inning run distribution over lineup slots.
function avgFresh(R, mask = 0) {
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
function homeWP(half, diff, cur, nextHome, X) {
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
function restOfHalf(R, TR, branches, curBatterDist, slot) {
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
function stepFromBatter(R, TR, outs, mask, slot, dist) {
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
function lineupDists(batters, pitcher, lg, tired) {
  return batters.map((b) => paTarget(b, pitcher, { lg, tired, tto: 0 }));
}

Object.assign(exports, { inningEndFix, transitions, halfTable, runDist, extraTied, avgFresh, homeWP, restOfHalf, stepFromBatter, lineupDists, MAXR, TYPES, maskOf });
});
__def("ui/art.js", function (exports) {
// Small SVG figures drawn in code (no image files).

// Batter in his stance, seen from behind the catcher. A right-handed hitter
// stands on the left side of the plate facing it; lefties are mirrored. Lit
// from behind by the floodlights, so the body is dark with a chalk rim.
function batterSilhouette(side, color) {
  const flip = side === 'L' ? ' transform="translate(120 0) scale(-1 1)"' : '';
  const pants = '#34353b', bat = '#8a6b45';
  return `<svg class="batter-svg" viewBox="0 0 120 220" aria-hidden="true">
    <g${flip}>
      <g stroke-linecap="round" stroke-linejoin="round">
        <path d="M59 99 L46 146 L41 199" stroke="${pants}" stroke-width="13" fill="none"/>
        <path d="M76 99 L89 146 L97 199" stroke="${pants}" stroke-width="13" fill="none"/>
        <ellipse cx="38" cy="203" rx="11" ry="5" fill="#141416"/>
        <ellipse cx="102" cy="203" rx="11" ry="5" fill="#141416"/>
        <path d="M55 52 Q66 45 79 52 L85 98 Q70 108 52 101 Z" fill="${color}" stroke="${color}" stroke-width="2"/>
        <circle cx="67" cy="34" r="13" fill="${color}"/>
        <path d="M74 27 Q86 29 90 37 L74 37 Z" fill="${color}"/>
        <g class="arms">
          <path d="M48 47 L53 42 L27 3 L19 8 Z" fill="${bat}" stroke="${bat}" stroke-width="1"/>
          <path d="M60 58 L50 45" stroke="${color}" stroke-width="9" fill="none"/>
          <path d="M77 58 Q66 52 50 45" stroke="${color}" stroke-width="9" fill="none"/>
        </g>
      </g>
      <g fill="none" stroke="var(--chalk)" stroke-opacity=".55" stroke-width="1.3" stroke-linecap="round">
        <path d="M58 22 Q66 19 75 24"/>
        <path d="M80 52 L86 98"/>
        <path d="M90 147 L98 199"/>
      </g>
    </g>
  </svg>`;
}

// Speed on the 20-80 scale: two bolts for the fastest 5% of hitters, one bolt
// for the top 17%, a "slow" tag for the slowest fifth.
function speedLabel(spd) {
  if (spd >= 70) return { word: 'Burner', bolts: 2 };
  if (spd >= 60) return { word: 'Fast', bolts: 1 };
  if (spd < 42) return { word: 'Slow', bolts: 0, slow: true };
  return { word: 'Average', bolts: 0 };
}

const BOLT = '<svg class="bolt" viewBox="0 0 9 12" aria-hidden="true"><path d="M5.6 0 L1 6.6 L4 6.6 L2.8 12 L8 4.8 L5 4.8 Z" fill="currentColor"/></svg>';

// Inline speed badge for HTML lists: bolts, the word and the rating.
function speedBadge(spd) {
  const s = speedLabel(spd);
  const word = s.bolts || s.slow ? s.word : 'Speed';
  return `<span class="spd ${s.slow ? 'slow' : s.bolts ? 'fast' : ''}" title="Speed ${spd} (20-80 scale)">${BOLT.repeat(s.bolts)}${word} ${spd}</span>`;
}

Object.assign(exports, { batterSilhouette, speedLabel, speedBadge });
});
__def("ui/coach.js", function (exports) {
// Plain-English help for new managers: what each control does, what the
// inning needs, which runs matter, and (after a call is graded) why the best
// call was best. Nothing here tells the player the answer before they choose.
const { paTarget, fatigue } = __req("engine/model.js");
const { stealProb } = __req("engine/tactics.js");
const { ordinal } = __req("engine/game.js");
const { settings, setSetting, load } = __req("ui/store.js");

// ---------------------------------------------------------------- control help
const SIGN_HELP = {
  normal: 'Swing at good pitches. The default.',
  take: "Don't swing at this one. Makes a wild pitcher throw a strike.",
  takeUntilStrike: "Don't swing until he throws a strike.",
  sitFB: 'Look fastball and drive it. Fooled by breaking balls.',
  protect: 'Shorten up and put it in play. Fewer strikeouts, less power.',
  sac: 'Bunt the runners up a base. The batter is usually out.',
  drag: 'Bunt for a hit. Best with a fast batter and the infield back.',
  squeeze: 'Runner on third breaks with the pitch; the batter must bunt.',
  safety: 'Runner on third goes only if the bunt is down.',
  steal2: 'Runner on first runs on the pitch.',
  steal3: 'Runner on second runs on the pitch.',
  steal4: 'Runner on third tries to steal home. Rarely works.',
  double: 'Both runners go at once.',
  hitrun: 'Runner goes; the batter must swing to protect him.',
  runhit: 'Runner goes; the batter swings only at strikes.',
};
const DEF_HELP = {
  'inf:normal': 'Standard depth. Most grounders are outs.',
  'inf:in': 'Cut the run off at the plate. More grounders get through.',
  'inf:dp': 'Turn two on a grounder. Leaves more holes.',
  'inf:corners': 'Third and first creep in for the bunt.',
  'inf:lines': 'No doubles down the lines.',
  'of:normal': 'Standard depth.',
  'of:deep': 'Nothing over their heads. More bloops fall in.',
  'of:shallow': 'Throw out a runner at the plate. Deep flies fall in.',
  'shift:true': 'Overload the pull side against a lefty.',
};

const PITCH_HELP = {
  FF: 'Hard and straight', SI: 'Bores in, gets grounders', FC: 'Late cut, breaks bats',
  SL: 'Sharp, late break', CU: 'Big, slow drop', KC: 'Hard, deep drop',
  CH: 'Looks like a fastball, arrives late', FS: 'Dives under the bat', SC: 'Breaks the other way',
  KN: 'Floats and flutters',
};

// ---------------------------------------------------------------- the inning
const WHERE = ['on first', 'on second', 'on third'];

// Who carries the tying and go-ahead runs for the team at bat.
function keyRuns(g) {
  const bat = g.half;
  const need = g.score[1 - bat] - g.score[bat];
  if (need < 0) return {};
  const order = [];
  for (let i = 2; i >= 0; i--) if (g.bases[i]) order.push({ where: WHERE[i], base: i, name: g.bases[i].name });
  const t = g.bat();
  const up = ['at the plate', 'on deck', 'in the hole'];
  for (let k = 0; k < 3; k++) {
    const pl = g.P(t.lineup[(t.slot + k) % 9].pid);
    order.push({ where: up[k], base: k === 0 ? 'bat' : null, name: pl.l || pl.n });
  }
  const walkoff = bat === 1 && g.inning >= 9;
  const out = {};
  if (need >= 1 && order[need - 1]) out.tying = order[need - 1];
  if (order[need]) out.ahead = { ...order[need], label: walkoff ? 'Winning run' : 'Go-ahead run' };
  return out;
}

function runTags(g) {
  const k = keyRuns(g);
  const tags = [];
  if (k.tying) tags.push(`Tying run ${k.tying.where}`);
  if (k.ahead) tags.push(`${k.ahead.label} ${k.ahead.where}`);
  return tags;
}

// One sentence: what this half-inning needs from the player's team.
function mission(g, me) {
  if (g.over) return { head: g.winner === me ? 'Ballgame. You won.' : 'Ballgame.', sub: '' };
  const diff = g.score[me] - g.score[1 - me];
  const left = 3 - g.outs;
  const outs = `${left} out${left === 1 ? '' : 's'}`;
  const last = g.inning >= 9;
  if (g.half === me) {
    const homeLast = me === 1 && last;
    if (diff < 0) return { head: `Score ${-diff} to tie, ${1 - diff} to ${homeLast ? 'win' : 'lead'}`, sub: `${outs} left` };
    if (diff === 0) return { head: homeLast ? 'Score 1 and you win' : 'Score 1 to take the lead', sub: `${outs} left` };
    return { head: `Add to your ${diff}-run lead`, sub: `${outs} left, then protect it` };
  }
  const ends = last && ((me === 1 && g.half === 0 && diff > 0) || (me === 0 && g.half === 1 && diff > 0));
  if (diff > 0) return { head: ends ? `Get ${outs} and you win` : `Protect your ${diff}-run lead`, sub: `${outs} to go` };
  if (diff === 0) {
    const walkoff = me === 0 && g.half === 1 && last;
    const homeNext = me === 1 && g.half === 0 && last;
    return { head: walkoff ? 'One run and you lose' : 'Keep it tied', sub: homeNext ? `Get ${outs}, then score 1 to win` : `Get ${outs}` };
  }
  return { head: `Hold them: down ${-diff}`, sub: `Get ${outs}, then you bat` };
}

function countTalk(c) {
  const k = `${c.b}-${c.s}`;
  if (k === '0-0') return 'First pitch';
  if (k === '3-2') return 'Full count';
  if (['2-0', '3-0', '3-1', '2-1'].includes(k)) return "Hitter's count";
  if (['0-2', '1-2', '0-1'].includes(k)) return "Pitcher's count";
  return 'Even count';
}

// ---------------------------------------------------------------- projections
function reach(g, batter, pitcher, tired = 0) {
  const d = paTarget(batter, pitcher, { lg: g.lg, tired });
  return { obp: d.BB + d.HBP + d.B1 + d.B2 + d.B3 + d.HR, xb: d.B2 + d.B3 + d.HR };
}
const pctw = (x) => `${Math.round(x * 100)}%`;
function pitcherTired(g, team, pid) {
  if (pid === team.pitcher) return g.pitcherTired(team);
  return fatigue(g.P(pid), 0, team.energy[pid] ?? 1, false);
}
function stealOdds(g, base) {
  const runner = base === 2 ? g.bases[0] : base === 3 ? g.bases[1] : base === 4 ? g.bases[2] : null;
  if (!runner) return null;
  return stealProb(runner, base, g.situationCtx());
}

// ---------------------------------------------------------------- why (after the call)
const INF_WHY = {
  normal: 'Normal depth turns more grounders into outs; the infield in lets more of them through.',
  in: 'With the infield in, a grounder can cut down the run at the plate. It costs a few singles.',
  dp: 'At double-play depth, one grounder can end the threat with two outs.',
  corners: 'With the corners in, a bunt is a lot harder to get down safely.',
  lines: 'Guarding the lines takes away the double down the line late in a close game.',
};
const OF_WHY = {
  normal: 'Normal outfield depth: playing deep or shallow gave up more than it saved here.',
  deep: 'Playing deep keeps the ball in front of the outfielders, so a hit can\'t score a runner from first.',
  shallow: 'A shallow outfield can throw out the runner at the plate on a single.',
};

function whyDefense(g, chosen, best) {
  const ft = g.fld();
  const batter = g.P(g.batter().pid);
  const cur = chosen.pid || ft.pitcher;
  if (best.pid && best.pid !== cur) {
    const a = g.P(best.pid), b = g.P(cur);
    const ra = reach(g, batter, a, pitcherTired(g, ft, best.pid));
    const rb = reach(g, batter, b, pitcherTired(g, ft, cur));
    const tiredNote = cur === ft.pitcher && g.pitcherTired(ft) > 0.3 ? `, and ${b.l} is tiring` : '';
    return `${a.l} was the better arm: ${batter.l} reaches base about ${pctw(ra.obp)} of the time against him, ${pctw(rb.obp)} against ${b.l}${tiredNote}.`;
  }
  if (!!best.ibb !== !!chosen.ibb) {
    const t = g.bat();
    const next = g.P(t.lineup[(t.slot + 1) % 9].pid);
    const pit = g.P(cur);
    const now = reach(g, batter, pit, pitcherTired(g, ft, cur));
    const then = reach(g, next, pit, pitcherTired(g, ft, cur));
    if (best.ibb) return `Walking ${batter.l} (on base ${pctw(now.obp)} of the time here) brings up ${next.l} (${pctw(then.obp)}) and sets up a force at every base.`;
    return `The walk put another runner on. ${batter.l} gets on ${pctw(now.obp)} of the time; that wasn't enough to be worth it.`;
  }
  const ba = best.align || {}, ca = chosen.align || {};
  if (ba.inf && ba.inf !== ca.inf) return INF_WHY[ba.inf] || '';
  if (ba.of && ba.of !== ca.of) return OF_WHY[ba.of] || '';
  return '';
}

const TACTIC_WHY = {
  swing: 'Swinging away keeps the out and the big hit in play.',
  take: 'Taking makes the pitcher throw a strike first.',
  sac: 'The bunt trades an out for a base and puts the runner closer to home.',
  squeeze: 'The squeeze scores the runner from third unless the batter misses the bunt.',
  safety: 'The safety squeeze scores the runner when the bunt is good and risks little when it isn\'t.',
  drag: 'Bunting for a hit uses his speed against an infield playing back.',
  hitrun: 'The hit-and-run puts the ball in play with the runner moving and keeps the double play off.',
};

function whyOffense(g, chosen, best) {
  const pit = g.pitcherObj();
  const tired = g.pitcherTired(g.fld());
  if (best.batter && best.batter !== chosen.batter) {
    const a = g.P(best.batter), b = g.P(chosen.batter);
    const ra = reach(g, a, pit, tired), rb = reach(g, b, pit, tired);
    return `${a.l} hits ${pit.l} better: on base about ${pctw(ra.obp)} of the time, against ${pctw(rb.obp)} for ${b.l}.`;
  }
  const br = best.runners || [], cr = chosen.runners || [];
  for (let i = 0; i < 3; i++) {
    if (br[i] && cr[i] && br[i] !== cr[i]) {
      const a = g.P(br[i]), b = g.P(cr[i]);
      return `${a.l} is the faster runner (speed ${a.spd} to ${b.spd}), more likely to score on a hit.`;
    }
  }
  if (best.tactic !== chosen.tactic) {
    const steal = { steal2: 2, steal3: 3, steal4: 4, double: 3 };
    if (steal[best.tactic]) {
      const p = stealOdds(g, steal[best.tactic]);
      return `The steal was worth it: he makes it about ${pctw(p ?? 0.5)} of the time, and a runner in scoring position changes everything here.`;
    }
    if (steal[chosen.tactic]) {
      const p = stealOdds(g, steal[chosen.tactic]);
      return `He makes that steal only about ${pctw(p ?? 0.5)} of the time; getting caught costs the runner and an out. ${TACTIC_WHY[best.tactic] || ''}`.trim();
    }
    if (chosen.tactic === 'sac' || chosen.tactic === 'squeeze' || chosen.tactic === 'safety' || chosen.tactic === 'drag') {
      return best.tactic === 'swing' ? 'The bunt gave away an out. Swinging away kept the inning alive and the big hit possible.' : TACTIC_WHY[best.tactic] || '';
    }
    return TACTIC_WHY[best.tactic] || '';
  }
  return '';
}

// ---------------------------------------------------------------- tips (once each)
function coachOn() {
  const c = settings().coach;
  if (c === 'on') return true;
  if (c === 'off') return false;
  return load().totals.games < 3;
}
function setCoach(on) { setSetting('coach', on ? 'on' : 'off'); }
function seen() { const s = settings(); return s.seen || (s.seen = {}); }
function markSeen(key) { seen()[key] = 1; setSetting('seen', seen()); }

// The first unseen tip that fits the moment. Tips explain the tradeoff, never the answer.
function tipFor(g, me) {
  if (g.over || g.pending) return null;
  const s = seen();
  const fielding = g.half !== me;
  const b = g.bases;
  const tips = [];
  if (fielding) {
    const ft = g.fld();
    tips.push(['call', true, 'Pick a pitch, then tap where you want it. Pitches on the edges are hard to hit; misses over the middle get crushed. Not sure? Let the catcher call it.']);
    tips.push(['tired', g.pitcherTired(ft) > 0.3, `${g.P(ft.pitcher).l} is tiring: his stuff and control slip. Warm up a reliever in the bullpen now; one who comes in cold isn't as sharp.`]);
    tips.push(['third', b[2] && g.outs < 2, 'Runner on third, less than two out. Infield in can cut him down at the plate on a grounder, but more grounders get through for hits.']);
    tips.push(['dp', b[0] && g.outs < 2, 'Runner on first, less than two out. Double-play depth turns more grounders into two outs, but leaves bigger holes.']);
    tips.push(['ibb', !b[0] && (b[1] || b[2]), 'First base is open. A walk sets up a force at every base and brings up the next hitter, but it puts another runner on.']);
    tips.push(['platoon', true, 'Hitters do worse against pitchers who throw from the same side they bat from. That is why managers bring in a lefty to face a lefty.']);
  } else {
    const up = g.batter();
    tips.push(['pitcherUp', up.pos === 1 && !g.paStarted && g.bat().bench.length > 0, 'Your pitcher is due up, and pitchers rarely hit. You can send a pinch hitter from the Bench before the first pitch, but the pitcher leaves the game for good.']);
    tips.push(['sign', true, 'Give a sign before each pitch. Swing away is the default. Bunts, steals and the hit-and-run can win the game, but each costs you when it fails.']);
    tips.push(['steal', b[0] && !b[1], 'Your runner on first can steal second. Fast runners make it most of the time; getting caught costs the runner and an out.']);
    tips.push(['sac', (b[0] || b[1]) && g.outs === 0, 'A sacrifice bunt gives up an out to move the runners up a base, closer to scoring on a single.']);
    tips.push(['squeeze', b[2] && g.outs < 2, 'Runner on third: a squeeze scores him on a bunt. If the batter misses, the runner is out at the plate.']);
    tips.push(['ph', !g.paStarted && g.bat().bench.length > 0, 'Before the first pitch you can send up a pinch hitter from the bench. Anyone you take out of the game can\'t come back.']);
  }
  for (const [key, when, text] of tips) if (when && !s[key]) return { key, text };
  return null;
}

const halfName = (g) => `${g.half ? 'Bottom' : 'Top'} of the ${ordinal(g.inning)}`;

Object.assign(exports, { keyRuns, runTags, mission, countTalk, reach, stealOdds, whyDefense, whyOffense, coachOn, setCoach, markSeen, tipFor, SIGN_HELP, DEF_HELP, PITCH_HELP, halfName });
});
__def("ui/field.js", function (exports) {
// The ballpark at night: a floodlit field drawn in SVG from a camera high
// behind home plate. Positions are laid out top-down (home at 200,338, center
// field toward y=0) and projected; straight lines stay straight.
const { esc } = __req("ui/util.js");
const { speedLabel } = __req("ui/art.js");

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
function proj(x, y) {
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
function renderField(g, last, fx = null, keyRuns = {}) {
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
function pitchFlight(svg, ms) {
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

Object.assign(exports, { proj, renderField, pitchFlight });
});
__def("ui/main.js", function (exports) {
// Boot and routing.
const { makeRng } = __req("engine/rng.js");
const { $, esc, toast, openSheet, closeSheet, copyText, dayNumber, dailyOrder } = __req("ui/util.js");
const { load, save, recordGame, recordStars, exportCode, importCode } = __req("ui/store.js");
const { PASS, canPlay, redeem, recheck, forget, member } = __req("ui/pass.js");
const { resultCard, shareResult } = __req("ui/share.js");
const { teamColors } = __req("ui/teams.js");
const { mountGame } = __req("ui/play.js");
const { soundOn, toggleSound, unlock } = __req("ui/sound.js");
const { homeHtml, archiveHtml, pregameHtml, resultHtml, statsHtml, howtoHtml, shareText, realManagerCalls, realCallsHtml, wireChart, setNameShard, starsFor, starsHtml, collectionRows, passHtml, FIRST_GAME } = __req("ui/views.js");

const LETTER = { green: 'A', yellow: 'B', orange: 'C', red: 'F' };
const FROM_LETTER = { A: 'green', B: 'yellow', C: 'orange', F: 'red' };
const gateCtx = () => ({ firstGame: FIRST_GAME, day: app.dayNo });

const app = { index: [], shards: {}, game: null, filters: { limit: 120 }, pre: null };
const root = () => document.getElementById('app');

function shuffle(arr, seed) {
  const rng = makeRng(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getShard(file) {
  if (!app.shards[file]) {
    const res = await fetch('data/' + file);
    if (!res.ok) throw new Error('Could not load ' + file);
    app.shards[file] = await res.json();
  }
  return app.shards[file];
}
async function getScenario(id) {
  const row = app.index.find((r) => r.id === id);
  if (!row) return null;
  const shard = await getShard(row.shard);
  return { row, sc: shard.scenarios[id], shard };
}

const MARK = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="#f2efe6"/><path d="M14 14c9 9 9 27 0 36M50 14c-9 9-9 27 0 36" fill="none" stroke="#c8102e" stroke-width="3.2" stroke-dasharray="4 3"/></svg>`;
const SPEAKER = (on) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${on ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' : '<path d="M16.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'}</svg>`;

function shell(active, body) {
  const link = (h, l) => `<a href="#${h}" ${active === h ? 'aria-current="page"' : ''}>${l}</a>`;
  const on = soundOn();
  root().innerHTML = `<header class="topbar"><div class="in">
      <a class="brand" href="#home">${MARK}<b>Last Licks</b><span>Manage the ninth</span></a>
      <nav class="nav" aria-label="Main">${link('daily', 'Today')}${link('survivor', 'Win or Go Home')}${link('archive', 'Archive')}${link('stats', 'Record')}</nav>
      <div class="tb-tools">
        <button class="iconbtn" id="snd" aria-pressed="${on}" title="Sound ${on ? 'on' : 'off'}" aria-label="Sound ${on ? 'on' : 'off'}">${SPEAKER(on)}</button>
        <button class="iconbtn" id="help" title="How to play" aria-label="How to play">?</button>
      </div>
    </div></header><main id="main">${body}</main>`;
  $('#help').onclick = showHelp;
  $('#snd').onclick = () => {
    const now = toggleSound();
    const b = $('#snd');
    b.setAttribute('aria-pressed', now);
    b.title = `Sound ${now ? 'on' : 'off'}`;
    b.setAttribute('aria-label', b.title);
    b.innerHTML = SPEAKER(now);
    toast(now ? 'Sound on.' : 'Sound off.');
  };
}
function showHelp() { openSheet('How to play', howtoHtml()); }

// ---------------------------------------------------------------- routes
async function route() {
  if (app.game && app.game.destroy) { app.game.destroy(); app.game = null; }
  closeSheet();
  const h = (location.hash || '#home').slice(1);
  try {
    if (h === 'home' || h === '') return renderHome();
    const locked = PASS.on && !member();
    if (h === 'pass') return renderPass();
    if (h.startsWith('c-')) return renderChallenge(h.slice(2));
    if (h === 'archive') return locked ? renderPass() : renderArchive();
    if (h.startsWith('list-')) { if (locked) return renderPass(); app.filters = { limit: 120, coll: h.slice(5) }; return renderArchive(); }
    if (h.startsWith('rand-')) return locked ? renderPass() : randomFrom(h.slice(5));
    if (h === 'stats') { shell('stats', statsHtml(app)); wireStats(); return; }
    if (h === 'daily') {
      const id = todayRow().id;
      if (!canPlay('daily', id, gateCtx())) return renderPass("You've played today's game. Come back tomorrow for a new one, or get the Season Pass to replay it and play any of the 500.");
      return renderPregame(id, { mode: 'daily' });
    }
    if (h === 'survivor') return renderSurvivor();
    if (h.startsWith('s-')) {
      const id = h.slice(2);
      if (!canPlay('archive', id, gateCtx())) return renderPass();
      return renderPregame(id, { mode: 'archive' });
    }
    return renderHome();
  } catch (e) {
    console.error(e);
    shell('', `<div class="wrap"><div class="loading">Something went wrong loading that page. ${esc(e.message)}</div></div>`);
  }
}

function todayRow() {
  const order = dailyOrder(app.index, shuffle);
  const n = app.dayNo;
  return order[((n - 1) % order.length + order.length) % order.length];
}

function renderHome() {
  app.today = todayRow();
  shell('home', homeHtml(app));
}

// a random game from a playlist, preferring ones not played yet
function randomFrom(key) {
  const rows = collectionRows(app, key);
  if (!rows.length) { location.hash = 'archive'; return; }
  const st = load();
  const fresh = rows.filter((r) => !st.played[r.id]);
  const pool = fresh.length ? fresh : rows;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  history.replaceState(null, '', '#s-' + pick.id);
  return renderPregame(pick.id, { mode: 'archive' });
}

function renderArchive() {
  shell('archive', archiveHtml(app, app.filters));
  const upd = () => {
    app.filters = {
      q: $('#q').value, dec: $('#fdec').value, round: $('#fround').value, sit: $('#fsit').value,
      played: $('#fplayed').value, legend: $('#flegend').checked, limit: app.filters.limit, coll: $('#fcoll').value,
    };
    const pos = $('#q').selectionStart;
    shell('archive', archiveHtml(app, app.filters));
    wire();
    const q = $('#q');
    if (document.activeElement !== q && app._typing) { q.focus(); q.setSelectionRange(pos, pos); }
  };
  const wire = () => {
    $('#q').addEventListener('input', () => { app._typing = true; upd(); });
    for (const id of ['#fdec', '#fround', '#fsit', '#fplayed', '#flegend', '#fcoll']) $(id).addEventListener('change', () => { app._typing = false; upd(); });
    const more = $('#more');
    if (more) more.onclick = () => { app.filters.limit = (app.filters.limit || 120) + 120; app._typing = false; upd(); };
  };
  wire();
}

async function renderPregame(id, opts) {
  const tab = opts.mode === 'daily' ? 'daily' : opts.mode === 'survivor' ? 'survivor' : 'archive';
  shell(tab, '<div class="wrap"><div class="loading">Loading the lineup cards…</div></div>');
  const got = await getScenario(id);
  if (!got) return renderHome();
  const { sc, shard } = got;
  setNameShard(shard);
  const choice = app.pre && app.pre.id === id ? app.pre : { id, side: sc.side, start: 0, mode: opts.mode };
  choice.mode = opts.mode;
  app.pre = choice;
  const draw = () => {
    shell(tab, pregameHtml(app, sc, choice));
    $('#main').onclick = (e) => {
      const s = e.target.closest('[data-side]');
      if (s) { choice.side = +s.dataset.side; return draw(); }
      const st = e.target.closest('[data-start]');
      if (st) { choice.start = +st.dataset.start; return draw(); }
      if (e.target.closest('[data-go]')) { unlock(); startGame(sc, shard, choice); }
    };
  };
  draw();
}

function startGame(sc, shard, choice) {
  const startIdx = sc.starts[choice.start] ? sc.starts[choice.start].idx : 0;
  const day = app.dayNo;
  const seed = choice.seed || (choice.mode === 'daily' ? `daily-${day}-${sc.id}-${choice.side}-${startIdx}` : `${sc.id}-${Date.now().toString(36)}`);
  shell(choice.mode === 'daily' ? 'daily' : choice.mode === 'survivor' ? 'survivor' : 'archive', '<div id="gameroot"></div>');
  const gr = document.getElementById('gameroot');
  app.game = mountGame(gr, {
    sc, shard, userSide: choice.side, startIdx, mode: choice.mode, day, seed,
    onHelp: showHelp,
    onQuit: () => { location.hash = choice.mode === 'daily' ? 'home' : 's-' + sc.id; route(); },
    onFinish: (res) => finishGame(sc, shard, choice, res),
  });
  window.scrollTo({ top: 0 });
}

function finishGame(sc, shard, choice, res) {
  recordGame(res);
  const extra = {};
  const st = load();
  if (choice.mode === 'survivor') {
    const run = st.survivor.run;
    if (run) {
      const sound = res.grades.length > 0 && res.grades.every((g) => g === 'green' || g === 'yellow');
      if (res.won) {
        run.wins++; run.idx++;
        st.survivor.best = Math.max(st.survivor.best, run.wins);
        extra.survivor = `Win or Go Home: ${run.wins} straight. On to the next one.`;
        extra.next = 'Next game';
      } else if (sound && !run.passUsed) {
        run.passUsed = true; run.idx++;
        extra.survivor = 'Tough break: every call was sound, so you get your one free pass. The run lives.';
        extra.next = 'Next game';
      } else {
        extra.survivor = `Run over after ${run.wins} ${run.wins === 1 ? 'win' : 'wins'}.${run.wins >= st.survivor.best && run.wins > 0 ? ' A new best.' : ''}`;
        st.survivor.best = Math.max(st.survivor.best, run.wins);
        st.survivor.run = null;
        extra.next = 'Start a new run';
      }
      save();
    }
  }
  if (choice.challenge) extra.challenge = choice.challenge;
  // two stars are known now; the third waits for the real manager's grades
  extra.stars = starsFor(res, null);
  recordStars(sc.id, extra.stars);
  shell(choice.mode === 'daily' ? 'daily' : choice.mode === 'survivor' ? 'survivor' : 'archive', resultHtml(app, sc, res, extra));
  wireChart($('#main'), res.wp);
  window.scrollTo({ top: 0 });
  $('#main').onclick = async (e) => {
    if (e.target.closest('[data-copy]')) {
      const ok = await copyText(shareText(app, sc, res));
      if (ok) toast('Copied. Paste it anywhere.');
      else {
        const r = document.createRange();
        r.selectNodeContents($('#share'));
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        toast('Selected. Copy it with your keyboard.');
      }
    }
    const replay = (opts) => {
      if (!canPlay('archive', sc.id, gateCtx())) { location.hash = 'pass'; return; }
      startGame(sc, shard, opts);
    };
    if (e.target.closest('[data-again]')) replay({ ...choice, seed: null, challenge: null, mode: 'archive' });
    if (e.target.closest('[data-swap]')) replay({ ...choice, seed: null, challenge: null, side: 1 - choice.side, mode: 'archive' });
    if (e.target.closest('[data-sharecard]')) {
      const btn = e.target.closest('[data-sharecard]');
      btn.disabled = true;
      const blob = await resultCard({ event: sc.event, title: sc.title, team: sc.teams[res.side].nick, won: res.won, score: [res.score[res.side], res.score[1 - res.side]], grades: res.grades, stars: extra.stars || [0, 0, 0], color: teamColors(sc.teams[0].code, sc.teams[1].code)[res.side], url: siteUrl() });
      const r = await shareResult({ text: shareText(app, sc, res), url: challengeUrl(sc, res), blob });
      btn.disabled = false;
      if (r === 'copied') toast('Copied. Paste it anywhere.');
      if (r === 'failed') toast('Sharing is not available here. Copy the text instead.');
    }
    if (e.target.closest('[data-challenge]')) {
      const url = challengeUrl(sc, res);
      const r = await shareResult({ text: `I managed ${sc.title} (${sc.event}) and ${res.won ? 'won' : 'lost'} ${res.score[res.side]}-${res.score[1 - res.side]}. Same game, same luck. Can you manage it better?`, url });
      if (r === 'copied') toast('Challenge link copied. Send it to a friend.');
      if (r === 'failed') toast(url);
    }
    if (e.target.closest('[data-next]')) { location.hash = 'survivor'; route(); }
  };
  // grade the real manager after the page is up, then settle the third star
  setTimeout(() => {
    const el = document.getElementById('realcalls');
    if (!el) return;
    const calls = realManagerCalls(sc, shard, choice.side);
    el.innerHTML = realCallsHtml(sc, choice.side, calls, res);
    const stars = recordStars(sc.id, starsFor(res, calls));
    const now = starsFor(res, calls);
    const box = document.getElementById('starrow');
    if (box) box.outerHTML = starsHtml(now, sc, choice.side, stars);
  }, 80);
}

async function renderSurvivor() {
  const st = load();
  if (!st.survivor.run) {
    shell('survivor', `<div class="wrap"><div class="pregame"><div class="today"><div class="lights"></div>
      <div class="eyebrow">Win or Go Home</div><h1>One loss and you're out</h1>
      <p class="intro">Historic 9th innings, back to back. You manage the team that's behind (or the home team in a tie), from the top of the 9th. Lose and the run is over, unless every call you made that game graded A or B: then you get one free pass per run.</p>
      <div class="actions"><button class="btn primary" id="go">Start a run</button></div></div>
      <div class="card panel"><h3>Best run</h3><p class="prompt-big num">${st.survivor.best}</p><p class="muted">Saved in this browser.</p></div></div></div>`);
    $('#go').onclick = () => {
      const seed = 'surv-' + Date.now();
      st.survivor.run = { seed, order: shuffle(app.index.map((r) => r.id), seed).slice(0, 500), idx: 0, wins: 0, passUsed: false };
      save();
      renderSurvivor();
    };
    return;
  }
  const run = st.survivor.run;
  const id = run.order[run.idx % run.order.length];
  app.pre = null;
  const got = await getScenario(id);
  app.pre = { id, side: got.sc.side, start: 0, mode: 'survivor' };
  return renderPregame(id, { mode: 'survivor' });
}

// ---------------------------------------------------------------- season pass, challenges, save codes
function siteUrl() { return location.origin + location.pathname; }
function challengeUrl(sc, res) {
  const grades = res.grades.map((x) => LETTER[x]).join('');
  const score = `${res.won ? 'W' : 'L'}${res.score[res.side]}-${res.score[1 - res.side]}`;
  return `${siteUrl()}#c-${[sc.id, res.side, res.start || 0, res.seed, grades || '0', score].join('~')}`;
}

async function renderChallenge(code) {
  const [id, side, start, seed, grades, score] = code.split('~');
  const got = id ? await getScenario(id) : null;
  if (!got || !seed) return renderHome();
  const { sc, shard } = got;
  setNameShard(shard);
  const si = Math.max(0, sc.starts.findIndex((st) => st.idx === +start));
  const challenge = { won: /^W/.test(score || ''), score: String(score || '').slice(1), grades: String(grades || '').split('').map((c) => FROM_LETTER[c]).filter(Boolean) };
  const choice = { id, side: +side === 1 ? 1 : 0, start: si, mode: 'challenge', seed, challenge };
  app.pre = choice;
  shell('archive', pregameHtml(app, sc, choice));
  $('#main').onclick = (e) => { if (e.target.closest('[data-go]')) { unlock(); startGame(sc, shard, choice); } };
}

function renderPass(note) {
  shell('archive', passHtml(app));
  if (note) {
    const intro = document.querySelector('.today .intro');
    if (intro) intro.textContent = note;
  }
  const btn = document.getElementById('redeem');
  if (btn) {
    btn.onclick = async () => {
      const msg = document.getElementById('passmsg');
      btn.disabled = true;
      msg.textContent = 'Checking…';
      const r = await redeem(document.getElementById('passkey').value);
      btn.disabled = false;
      if (r.ok) { toast('Season Pass unlocked. Enjoy the archive.'); location.hash = 'archive'; route(); } else msg.textContent = r.why;
    };
  }
}

function wireStats() {
  const sc = document.getElementById('savecode');
  if (sc) {
    sc.onclick = async () => {
      const code = exportCode();
      if (await copyText(code)) toast('Save code copied. Keep it somewhere safe.');
      else { const t = document.getElementById('restore'); t.value = code; t.select(); toast('Select and copy the code in the box.'); }
    };
  }
  const rb = document.getElementById('restorebtn');
  if (rb) {
    rb.onclick = () => {
      if (importCode(document.getElementById('restore').value)) { toast('Record restored.'); route(); } else toast('That save code did not work. Copy the whole code and try again.');
    };
  }
  const fp = document.getElementById('forgetpass');
  if (fp) fp.onclick = () => { forget(); toast('Season Pass removed from this device.'); route(); };
}

// ---------------------------------------------------------------- boot
async function boot() {
  app.dayNo = dayNumber();
  try {
    const res = await fetch('data/index.json');
    app.index = await res.json();
  } catch (e) {
    root().innerHTML = `<div class="wrap"><div class="loading">Couldn't load the scenario list. Reload the page to try again.</div></div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  recheck();
  if ('serviceWorker' in navigator && location.protocol === 'https:' && /github\.io|pages\.dev/.test(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

Object.assign(exports, {  });
});
__def("ui/pass.js", function (exports) {
// Season Pass: $4.99 a month unlocks the archive. Free players get today's
// game (once a day), Win or Go Home, the first game and challenge links.
// Payments go through Lemon Squeezy, which emails the buyer a license key.
// The site has no server, so the key is checked with Lemon Squeezy's license
// API from the browser and remembered on this device: an honor-system gate,
// since the game data itself is public.
const { load, save } = __req("ui/store.js");

const PASS = {
  on: false, // switch on once the checkout link below works
  price: '$4.99',
  per: 'month', // '' for a one-time price
  checkout: '', // Lemon Squeezy checkout link for the Season Pass product
  storeId: 0, // only keys from this store and product count (0 = don't check)
  productId: 0,
  recheckDays: 3,
};

const passOn = () => PASS.on;
function member() {
  const p = load().pass;
  return !!(p && p.ok);
}
const priceText = () => `${PASS.price}${PASS.per ? ` a ${PASS.per}` : ''}`;

// Free for everyone: today's game until it has been played, Win or Go Home,
// the hand-picked first game and challenge links from a friend.
function canPlay(mode, id, ctx) {
  if (!PASS.on || member()) return true;
  if (mode === 'survivor' || mode === 'challenge') return true;
  if (id === ctx.firstGame) return true;
  if (mode === 'daily') return !load().daily[ctx.day];
  return false;
}

async function check(key) {
  const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ license_key: key }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  const st = j.license_key && j.license_key.status;
  const meta = j.meta || {};
  if (PASS.storeId && meta.store_id !== PASS.storeId) return { ok: false, why: 'That key is for a different product.' };
  if (PASS.productId && meta.product_id !== PASS.productId) return { ok: false, why: 'That key is for a different product.' };
  if (!j.valid && st !== 'inactive') return { ok: false, why: st === 'expired' ? 'That Season Pass has ended. Renew it to keep playing the archive.' : 'That key wasn\'t recognized. Check it against your receipt email.' };
  if (st === 'expired' || st === 'disabled') return { ok: false, why: 'That Season Pass has ended. Renew it to keep playing the archive.' };
  return { ok: true, email: meta.customer_email || '' };
}

async function redeem(key) {
  key = String(key || '').trim();
  if (!key) return { ok: false, why: 'Paste the license key from your receipt email.' };
  try {
    const r = await check(key);
    if (r.ok) {
      load().pass = { key, ok: true, checked: Date.now(), email: r.email };
      save();
    }
    return r;
  } catch {
    return { ok: false, why: 'Couldn\'t reach the payment service. Check your connection and try again.' };
  }
}

// Every few days, make sure the pass is still active. Offline: keep it.
async function recheck() {
  const p = load().pass;
  if (!PASS.on || !p || !p.key || Date.now() - (p.checked || 0) < PASS.recheckDays * 86400000) return;
  try {
    const r = await check(p.key);
    p.ok = r.ok;
    p.checked = Date.now();
    save();
  } catch { /* offline: try again next time */ }
}

function forget() {
  delete load().pass;
  save();
}

Object.assign(exports, { member, canPlay, redeem, recheck, forget, PASS, passOn, priceText });
});
__def("ui/play.js", function (exports) {
// Game screen: you manage one dugout; the AI manages the other.
// One screen on phones and tablets: score strip, field, the at-bat panel and a
// dock of big buttons; everything else slides up in a sheet. Every pitch gets
// a beat (the ball lands on the zone and the call is stamped) and a grade.
// The player calls every pitch by default; with auto-play on, routine pitches
// play themselves and the game stops for the at-bat's first pitch, the big
// counts and new situations.
const { createGame, POS_ABBR, ordinal } = __req("engine/game.js");
const { aiPrePA, aiSign, aiDefensePitch } = __req("engine/ai.js");
const { winProb, gradeDefense, gradeOffense, forSide, pitchOutcomes, pitchValue, pitchGradeOf } = __req("engine/evaluate.js");
const { paTarget, battingSide, fatigue } = __req("engine/model.js");
const { zoneMap, PITCH_TYPES, cellIndex, cellH, cellV, inZone, inLook } = __req("engine/pitch.js");
const { renderField, pitchFlight } = __req("ui/field.js");
const { batterSilhouette, speedLabel, speedBadge } = __req("ui/art.js");
const { teamColors, teamAbbr } = __req("ui/teams.js");
const { pop, crack, crowdReact, charge, sting, setCrowd, stopCrowd, unlock, soundOn, toggleSound } = __req("ui/sound.js");
const { SIGN_HELP, DEF_HELP, PITCH_HELP, keyRuns, runTags, mission, countTalk, stealOdds, whyDefense, whyOffense, coachOn, setCoach, tipFor, markSeen } = __req("ui/coach.js");
const { esc, pct, avg3, toast, openSheet, closeSheet } = __req("ui/util.js");
const { settings, setSetting } = __req("ui/store.js");

const TACTIC_LABEL = {
  swing: 'swing away', take: 'take a pitch', sac: 'sacrifice bunt', squeeze: 'suicide squeeze',
  safety: 'safety squeeze', drag: 'drag bunt', steal2: 'steal second', steal3: 'steal third',
  steal4: 'steal home', double: 'double steal', hitrun: 'hit-and-run',
};
const INF_LABEL = { normal: 'normal', in: 'drawn in', dp: 'double-play depth', corners: 'corners in', lines: 'guarding the lines' };
const OF_LABEL = { normal: 'normal', deep: 'deep (no doubles)', shallow: 'shallow' };
const GRADE_WORD = { green: 'Best call', yellow: 'Close', orange: 'Costly', red: 'Big miss' };
const GRADE_LETTER = { green: 'A', yellow: 'B', orange: 'C', red: 'F' };
const GRADE_EMOJI = { green: '🟩', yellow: '🟨', orange: '🟧', red: '🟥' };
const RESULT_CLASS = { ball: 'ball', hbp: 'ball', called: 'strike', swinging: 'strike', foul: 'foul', inplay: 'inplay' };
const APPROACH = { normal: 'Swing away', take: 'Take', takeUntilStrike: 'Take until a strike', sitFB: 'Sit fastball', protect: 'Protect' };
const ONESHOT = { sac: 'Sacrifice', drag: 'Bunt for a hit', squeeze: 'Suicide squeeze', safety: 'Safety squeeze', steal2: 'Steal 2nd', steal3: 'Steal 3rd', steal4: 'Steal home', double: 'Double steal', hitrun: 'Hit and run', runhit: 'Run and hit' };
const LOOKS = [null];
for (let v = -1; v <= 1; v++) for (let h = -1; h <= 1; h++) if (h || v) LOOKS.push(cellIndex(h, v));
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function energyLabel(e) {
  if (e >= 0.85) return ['fresh', 'Fresh'];
  if (e >= 0.6) return ['ok', 'Rested'];
  if (e >= 0.35) return ['tired', 'Tired'];
  return ['gassed', 'Gassed'];
}

// Where a cell is, in the hitter's terms.
function spotWords(cell) {
  const h = cellH(cell), v = cellV(cell);
  const vert = { 2: 'high', 1: 'up', 0: '', '-1': 'down', '-2': 'in the dirt' }[v];
  const horiz = { 2: 'way inside', 1: 'in', 0: '', '-1': 'away', '-2': 'way outside' }[h];
  if (!vert && !horiz) return 'down the middle';
  return [vert, horiz].filter(Boolean).join(' and ');
}

// Movement of each pitch type as seen by the catcher: [arm-side or glove-side x, drop]
const BREAK = { FF: [0, -3, 330], SI: [-8, 9, 340], FC: [6, 2, 340], SL: [14, 6, 380], CU: [6, 20, 440], KC: [7, 18, 420], CH: [-8, 12, 420], FS: [0, 18, 400], SC: [-12, 10, 420], KN: [0, 0, 480] };

function mountGame(root, ctx) {
  const g = createGame(ctx.sc, ctx.shard, { userSide: ctx.userSide, startIdx: ctx.startIdx, seed: ctx.seed });
  const [awayC, homeC] = teamColors(ctx.sc.teams[0].code, ctx.sc.teams[1].code);
  const C = {
    g, userSide: ctx.userSide,
    ui: { ti: 0, cell: null, approach: 'normal', oneShot: null, look: null, pitchout: false, slideStep: false, tab: 'lineup', scouting: true },
    paKey: null, aiPlan: null, base: null, graded: false,
    grades: [], pitchGrades: [], wp: [], trace: [], noteGrade: null, notePitch: null, gradeFresh: false, lastPlay: null, lastBall: null, moves: {},
    startWp: null, done: false, fx: null, busy: false, skip: null,
    autoOn: false, autoTimer: null, manualPA: null, simPA: null, usedOneShot: false, paBases: '',
    shownWp: null, wpHome: null, halfKey: null, timers: [], flip: null, nbKey: null, sheet: null,
  };
  const me = () => C.userSide;
  const myTeam = () => g.teams[me()];
  const userBatting = () => g.half === me();
  const paKeyNow = () => g.paNo + ':' + g.inning + ':' + g.half;
  const basesKey = () => g.bases.map((r) => (r ? r.pid : '-')).join(',');
  const homeWp = () => { try { return winProb(g); } catch (e) { console.error(e); return null; } };
  const bump = (k) => { C.moves[k] = (C.moves[k] || 0) + 1; };
  const later = (fn, ms) => { const t = setTimeout(fn, ms); C.timers.push(t); return t; };
  const typeName = (ti) => { const t = g.matchup().types[ti]; return t ? ((PITCH_TYPES[t.key] || {}).short || t.key) : 'pitch'; };
  document.body.classList.add('in-game');

  // ------------------------------------------------------------ flow
  // Set up the next plate appearance: AI moves for either dugout, grading reset.
  function setupPA() {
    let guard = 0;
    while (!g.over && guard++ < 30) {
      const key = paKeyNow();
      if (key === C.paKey) break;
      C.paKey = key;
      const fSide = 1 - g.half, bSide = g.half;
      if (fSide !== me()) aiPrePA(g, fSide);
      if (g.over) break;
      if (paKeyNow() !== key) continue;
      C.aiPlan = bSide !== me() ? aiPrePA(g, bSide) : null;
      if (g.over) break;
      if (paKeyNow() !== key) continue;
      C.graded = false;
      C.base = userBatting() ? { batter: g.batter().pid, runners: g.bases.map((r) => (r ? r.pid : null)) } : { pid: g.fld().pitcher };
      C.ui.oneShot = null;
      C.ui.cell = null;
      C.ui.look = null;
      if (C.ui.approach !== 'takeUntilStrike') C.ui.approach = 'normal';
      C.ui.pitchout = false;
      C.ui.slideStep = false;
      C.usedOneShot = false;
      C.manualPA = null;
      C.paBases = basesKey();
      C.noteGrade = null;
      C.notePitch = null;
      try {
        const w = forSide(winProb(g), me());
        C.wp.push({ label: `${g.half ? 'B' : 'T'}${g.inning} ${g.outs} out`, wp: w });
        if (C.startWp === null) C.startWp = w;
      } catch (e) { console.error(e); }
    }
    const hk = `${g.inning}:${g.half}`;
    if (hk !== C.halfKey) {
      const first = C.halfKey === null;
      C.halfKey = hk;
      if (!first) C.lastBall = null;
      if (g.half === 1 && g.inning >= 9 && g.score[1] <= g.score[0] && !first) later(charge, 900);
    }
  }

  function takeSnap() {
    return { logLen: g.log.length, bases: g.bases.map((r) => (r ? r.pid : null)), batter: g.batter().pid, score: [...g.score], half: g.half, inning: g.inning, wpHome: C.wpHome };
  }

  // After the engine moves: play the beat, then show the new state.
  function settle(snap, opts = {}) {
    const evs = g.log.slice(snap.logLen);
    const pitchEv = [...evs].reverse().find((e) => e.kind === 'pitch' && e.pitch && e.pitch.cell !== undefined);
    const go = () => {
      if (C.done && !g.over) return;
      if (g.pending && g.pending.resolve) { show(snap, opts); return sendPrompt(); }
      setupPA();
      show(snap, opts);
      if (!g.over && g.pending && g.pending.kind === 'needPitcher' && g.pending.side === me()) bullpenSheet(true);
    };
    if (pitchEv && !opts.noBeat) beat(pitchEv, evs, !!opts.quick).then(go);
    else go();
  }

  function show(snap, opts = {}) {
    const evs = g.log.slice(snap.logLen);
    const sameHalf = snap.half === g.half && snap.inning === g.inning;
    const ball = evs.filter((e) => e.kind === 'play' && e.prof).pop() || null;
    const plays = evs.filter((e) => e.kind === 'play' || e.kind === 'walkoff');
    if (plays.length) C.lastPlay = plays[plays.length - 1].text;
    else {
      const p = evs.filter((e) => e.kind === 'pitch' || e.kind === 'move' || e.kind === 'note').pop();
      if (p) C.lastPlay = p.kind === 'pitch' ? `${p.text}. ${p.count.b}-${p.count.s}.` : p.text;
    }
    const runs = g.score[snap.half] - snap.score[snap.half];
    if (runs > 0) C.flip = snap.half;
    const moved = snap.bases.join() !== g.bases.map((r) => (r ? r.pid : null)).join();
    C.fx = null;
    if (sameHalf || g.over) {
      if (ball) C.lastBall = ball;
      if (ball || moved || runs > 0) {
        const order = [2, 1, 0].filter((i) => snap.bases[i]);
        order.push(-1);
        C.fx = { ball, prev: snap.bases, batter: snap.batter, scoredFrom: order.slice(0, Math.max(0, runs)) };
      }
    }
    refreshWp();
    if (C.wpHome !== null) C.trace.push({ label: `${g.half ? 'B' : 'T'}${g.inning} ${g.outs} out, ${g.count.b}-${g.count.s}`, wp: forSide(C.wpHome, me()) });
    // a sharp pitch call that still got burned
    const pg = opts.pitchGrade;
    if (pg && snap.wpHome !== null && C.wpHome !== null) {
      const swing = forSide(C.wpHome, me()) - forSide(snap.wpHome, me());
      if (pg.grade === 'green' && swing <= -0.03) C.notePitch = { grade: 'green', text: pg.side === 'def' ? 'Good pitch. He hit it anyway.' : 'Good sign. It didn\'t work out this time.' };
    }
    render();
    const b = bannerFor(evs, snap);
    if (b) banner(b);
    if (C.wpHome !== null && snap.wpHome !== null && snap.wpHome !== undefined) {
      const d = C.wpHome - snap.wpHome;
      if (Math.abs(d) >= 0.025) crowdReact(d > 0 ? 1 : -1, Math.min(1, Math.abs(d) * 3.5));
    }
    if (g.over) return finish();
    maybeAuto();
  }
  // The win chance shown only changes when the game moves, never while the
  // player tries out positioning, so it can't be used to find the best call.
  function refreshWp() {
    C.wpHome = g.over ? (g.winner === 1 ? 1 : 0) : homeWp();
  }

  function finish() {
    if (C.done) return;
    C.done = true;
    clearTimeout(C.autoTimer);
    const won = g.winner === me();
    const result = {
      id: ctx.sc.id, won, score: [...g.score], side: me(), grades: C.grades.map((x) => x.grade),
      gradeList: C.grades, pitchGrades: C.pitchGrades.map((x) => x.grade),
      wp: [{ label: 'Start', wp: C.startWp ?? 0.5 }, ...C.trace.slice(0, -1), { label: 'Final', wp: won ? 1 : 0 }],
      startWp: C.startWp, moves: C.moves, mode: ctx.mode, day: ctx.day, log: g.log, innings: g.inning,
      line: g.line, hits: g.hits, errors: g.errors, teams: g.teams.map((t) => t.nick), seed: ctx.seed, start: ctx.startIdx,
    };
    if (won) later(confetti, 250);
    later(() => sting(won), 500);
    later(() => { stopCrowd(); document.body.classList.remove('in-game'); ctx.onFinish(result); }, won ? 2900 : 2300);
  }

  // ------------------------------------------------------------ auto pace
  function shouldAuto() {
    if (g.over || g.pending || C.done || C.busy) return false;
    if (document.getElementById('sheet')) return false;
    if (C.simPA === paKeyNow()) return true;
    if (settings().pitches !== 'key') return false;
    if (!g.paStarted || C.manualPA === paKeyNow() || C.usedOneShot) return false;
    if (g.count.b === 3 || g.count.s === 2) return false;
    return basesKey() === C.paBases;
  }
  function maybeAuto() {
    clearTimeout(C.autoTimer);
    const was = C.autoOn;
    C.autoOn = shouldAuto();
    if (was !== C.autoOn) renderStatus();
    if (!C.autoOn) { if (C.simPA && C.simPA !== paKeyNow()) C.simPA = null; return; }
    C.autoTimer = later(() => {
      if (!shouldAuto()) { C.autoOn = false; renderStatus(); return; }
      if (userBatting()) doBat(true); else doPitch(true, true);
    }, C.simPA ? 220 : 420);
  }
  function takeOver() {
    clearTimeout(C.autoTimer);
    C.manualPA = paKeyNow();
    C.simPA = null;
    C.autoOn = false;
  }

  // ------------------------------------------------------------ grading
  function addGrade(kind, r, mine, best, why) {
    const entry = { kind, grade: r.grade, delta: r.delta, mine, best, why, inning: g.inning, half: g.half, mineWp: r.mine, bestWp: r.best.wp };
    C.grades.push(entry);
    C.noteGrade = entry;
    C.notePitch = null;
    C.gradeFresh = true;
  }
  function describeDef(opt) {
    const pl = g.P(opt.pid || g.fld().pitcher);
    const parts = [opt.pid && opt.pid !== C.base.pid ? `Bring in ${pl.l}` : `Stay with ${pl.l}`];
    if (opt.ibb) parts.push('walk him');
    const al = opt.align || {};
    if (!opt.ibb && al.inf && al.inf !== 'normal') parts.push(`infield ${INF_LABEL[al.inf]}`);
    if (!opt.ibb && al.of && al.of !== 'normal') parts.push(`outfield ${OF_LABEL[al.of]}`);
    if (parts.length === 1 && !opt.ibb) parts.push('pitch to him');
    return parts.join(', ');
  }
  function describeOff(opt) {
    const b = g.P(opt.batter);
    const parts = [opt.batter !== C.base.batter ? `${b.l} pinch-hits` : `${b.l} hits`];
    (opt.runners || []).forEach((pid, i) => {
      const orig = C.base.runners[i];
      if (pid && orig && pid !== orig) parts.push(`${g.P(pid).l} runs for ${g.P(orig).l}`);
    });
    parts.push(TACTIC_LABEL[opt.tactic] || opt.tactic);
    return parts.join(', ');
  }
  function gradeDef(ibb) {
    try {
      const ft = g.fld();
      const chosen = { pid: ft.pitcher, ibb, align: { inf: ft.align.inf, of: ft.align.of } };
      const r = gradeDefense(g, chosen, C.base);
      addGrade('def', r, describeDef(chosen), describeDef(r.best), r.grade === 'green' ? '' : whyDefense(g, chosen, r.best));
    } catch (e) { console.error(e); }
    C.graded = true;
  }
  function signTactic() {
    const o = C.ui.oneShot;
    if (o === 'sac' || o === 'squeeze' || o === 'safety' || o === 'drag' || o === 'hitrun') return o;
    if (o === 'steal2' || o === 'steal3' || o === 'steal4' || o === 'double') return o;
    if (C.ui.approach === 'takeUntilStrike' || C.ui.approach === 'take') return 'take';
    return 'swing';
  }
  function gradeOffNow() {
    try {
      const chosen = { batter: g.batter().pid, runners: g.bases.map((r) => (r ? r.pid : null)), tactic: signTactic() };
      const r = gradeOffense(g, chosen, C.base);
      addGrade('off', r, describeOff(chosen), describeOff(r.best), r.grade === 'green' ? '' : whyOffense(g, chosen, r.best));
    } catch (e) { console.error(e); }
  }

  // One pitch call against the best pitch that could have been called.
  function gradeMyPitch(useCatcher) {
    try {
      const O = pitchOutcomes(g);
      if (!O) return null;
      const M = O.M, count = `${g.count.b}-${g.count.s}`, fs = 1 - g.half;
      const row = (ti, t) => Array.from({ length: 25 }, (_, a) => M.scatter[ti][t * 25 + a]);
      let best = -1, bestKey = [0, 12];
      M.types.forEach((_, ti) => {
        for (let t = 0; t < 25; t++) {
          const v = forSide(pitchValue(O, [[1, ti, row(ti, t)]], count, 'normal', null, g.seq), fs);
          if (v > best) { best = v; bestKey = [ti, t]; }
        }
      });
      const mine = useCatcher
        ? forSide(pitchValue(O, M.autoActual(count).map((x, ti) => [x.p, ti, x.actual]), count, 'normal', null, g.seq), fs)
        : forSide(pitchValue(O, [[1, C.ui.ti, row(C.ui.ti, C.ui.cell)]], count, 'normal', null, g.seq), fs);
      const delta = Math.max(0, best - mine);
      return { grade: pitchGradeOf(delta), delta, side: 'def', mine: useCatcher ? "the catcher's call" : `${typeName(C.ui.ti)} ${spotWords(C.ui.cell)}`, best: `${typeName(bestKey[0])} ${spotWords(bestKey[1])}` };
    } catch (e) { console.error(e); return null; }
  }
  const signWords = (ap, lk) => `${APPROACH[ap] || 'Swing away'}${lk !== null && lk !== undefined ? `, looking ${spotWords(lk)}` : ''}`;
  // The hitter's sign for one pitch against the best sign for it.
  function gradeMySign() {
    if (C.ui.oneShot) return null;
    try {
      const O = pitchOutcomes(g);
      if (!O) return null;
      const M = O.M, count = `${g.count.b}-${g.count.s}`, bs = g.half;
      const mix = M.autoActual(count).map((x, ti) => [x.p, ti, x.actual]);
      let best = -1, bestKey = ['normal', null];
      for (const ap of ['normal', 'take', 'sitFB', 'protect']) {
        for (const lk of ap === 'take' ? [null] : LOOKS) {
          const v = forSide(pitchValue(O, mix, count, ap, lk, g.seq), bs);
          if (v > best) { best = v; bestKey = [ap, lk]; }
        }
      }
      const ap = C.ui.approach === 'takeUntilStrike' ? (g.count.s === 0 ? 'take' : 'normal') : C.ui.approach;
      const lk = ap === 'take' ? null : C.ui.look;
      const mine = forSide(pitchValue(O, mix, count, ap, lk, g.seq), bs);
      const delta = Math.max(0, best - mine);
      return { grade: pitchGradeOf(delta), delta, side: 'off', mine: signWords(ap, lk), best: signWords(bestKey[0], bestKey[1]) };
    } catch (e) { console.error(e); return null; }
  }
  function keepPitchGrade(pg, before) {
    if (!pg) return;
    C.pitchGrades.push(pg);
    const ev = g.log.slice(before).filter((e) => e.kind === 'pitch' && e.pitch).pop();
    if (ev) ev.grade = pg.grade;
    if (pg.grade === 'orange' || pg.grade === 'red') {
      C.notePitch = { grade: pg.grade, text: `${pg.side === 'def' ? 'Costly pitch call' : 'Costly sign'}: ${pg.mine}. Better: ${pg.best} (+${(pg.delta * 100).toFixed(1)} pts).` };
    }
  }

  // ------------------------------------------------------------ actions
  function doPitch(auto, quick) {
    if (g.pending || g.over || C.busy) return;
    if (!C.graded) gradeDef(false);
    if (!quick && C.tip && C.tip.key === 'call') { markSeen('call'); C.tip = null; }
    const useCatcher = auto || C.ui.cell === null;
    const pg = quick ? null : gradeMyPitch(useCatcher);
    const snap = takeSnap();
    const sign = aiSign(g, C.aiPlan);
    const call = useCatcher ? null : { ti: C.ui.ti, target: C.ui.cell };
    if (C.ui.pitchout) C.usedOneShot = true;
    g.pitch({ call, sign, defense: { pitchout: C.ui.pitchout, slideStep: C.ui.slideStep } });
    C.ui.pitchout = false;
    keepPitchGrade(pg, snap.logLen);
    settle(snap, { quick, pitchGrade: pg });
  }
  function buildSign() {
    const sign = { approach: C.ui.approach === 'takeUntilStrike' ? (g.count.s === 0 ? 'take' : 'normal') : C.ui.approach };
    const o = C.ui.oneShot;
    if (o === 'sac' || o === 'squeeze' || o === 'safety' || o === 'drag') sign.bunt = o;
    if (o === 'steal2') sign.steal = 2;
    if (o === 'steal3') sign.steal = 3;
    if (o === 'steal4') sign.steal = 4;
    if (o === 'double') sign.steal = 'double';
    if (o === 'hitrun') sign.hitRun = true;
    if (o === 'runhit') { sign.runHit = true; sign.steal = 2; }
    if (C.ui.look !== null && sign.approach !== 'take') sign.look = C.ui.look;
    return sign;
  }
  function doBat(quick) {
    if (g.pending || g.over || C.busy) return;
    if (!quick && C.tip && C.tip.key === 'sign') { markSeen('sign'); C.tip = null; }
    if (!C.graded) { gradeOffNow(); C.graded = true; } else if (C.ui.oneShot && C.ui.oneShot !== 'runhit') gradeOffNow();
    const o = C.ui.oneShot;
    if (o) {
      bump(o === 'sac' || o === 'drag' ? 'bunt' : o === 'squeeze' || o === 'safety' ? 'squeeze' : o === 'hitrun' || o === 'runhit' ? 'hitrun' : 'steal');
      C.usedOneShot = true;
    }
    const pg = quick ? null : gradeMySign();
    const snap = takeSnap();
    g.pitch({ call: null, sign: buildSign(), defense: aiDefensePitch(g) });
    C.ui.oneShot = null;
    if (C.ui.approach === 'take') C.ui.approach = 'normal';
    if (C.ui.approach === 'takeUntilStrike' && g.count.s > 0) C.ui.approach = 'normal';
    keepPitchGrade(pg, snap.logLen);
    settle(snap, { quick, pitchGrade: pg });
  }
  function simAtBat() {
    C.simPA = paKeyNow();
    C.manualPA = null;
    if (userBatting()) doBat(true); else doPitch(true, true);
  }
  function sendPrompt() {
    const p = g.pending;
    const runner = g.bases.find((r) => r && r.name === p.runner);
    const sp = runner ? speedLabel(runner.spd) : null;
    openSheet('Your call', `<p class="prompt-big">${esc(p.text)}</p>
      ${runner ? `<p style="margin:0">${speedBadge(runner.spd)} <span class="muted">${esc(runner.name)} is ${sp.word === 'Average' ? 'an average runner' : sp.word === 'Slow' ? 'slow' : sp.word === 'Burner' ? 'a burner' : 'fast'}.</span></p>` : ''}
      <p class="muted">Your third-base coach thinks he's safe about <b class="num">${pct(p.pSafe)}</b> of the time if you send him.</p>
      <div class="actions"><button class="btn primary" data-send="1">Send him</button><button class="btn" data-send="0">Hold him</button></div>`,
    (el) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-send]');
        if (!b) return;
        unlock();
        const snap = takeSnap();
        closeSheet();
        g.answer(b.dataset.send === '1');
        settle(snap, { noBeat: true });
      });
    }, { locked: true });
  }

  // ------------------------------------------------------------ the beat
  function paPitches() {
    const out = [];
    for (let i = g.log.length - 1; i >= 0; i--) {
      const e = g.log[i];
      if (e.kind === 'paStart') break;
      if (e.kind === 'pitch' && e.pitch && e.pitch.cell !== undefined) out.unshift(e);
    }
    return out;
  }
  function stampFor(pitchEv, evs) {
    const p = pitchEv.pitch;
    const plays = evs.filter((e) => e.kind === 'play');
    if (plays.some((e) => /strikes out/.test(e.text))) return ['Strike three', 'big'];
    if (plays.some((e) => / walks\./.test(e.text))) return ['Ball four', 'ball'];
    if (pitchEv.text === 'Bunt attempt') return ['Bunt', 'inplay'];
    const r = p.result;
    if (r === 'ball') return ['Ball', 'ball'];
    if (r === 'called') return ['Strike', 'strike'];
    if (r === 'swinging') return ['Swing and miss', 'strike'];
    if (r === 'foul') return ['Foul', 'foul'];
    if (r === 'hbp') return ['Hit by pitch', 'ball'];
    return ['In play', 'inplay'];
  }
  function beat(pitchEv, evs, quick) {
    const zone = root.querySelector('.zone');
    const p = pitchEv.pitch;
    const cellEl = zone && zone.querySelector(`[data-cell="${p.cell}"], [data-look="${p.cell}"]`);
    if (!cellEl) return Promise.resolve();
    const [word, cls] = stampFor(pitchEv, evs);
    const idx = g.log.indexOf(pitchEv);
    let n = 0;
    for (let i = idx; i >= 0; i--) { if (g.log[i].kind === 'paStart') break; if (g.log[i].kind === 'pitch' && g.log[i].pitch && g.log[i].pitch.cell !== undefined) n++; }
    C.busy = true;
    return new Promise((resolve) => {
      const timers = [];
      const done = () => {
        if (!C.busy) return;
        C.busy = false;
        C.skip = null;
        timers.forEach(clearTimeout);
        resolve();
      };
      C.skip = done;
      const [bx, by, ms] = BREAK[p.type] || BREAK.FF;
      const fly = reducedMotion() ? 0 : Math.round(ms * (quick ? 0.5 : 1));
      if (fly) {
        pitchFlight(root.querySelector('.g-field > svg'), fly);
        const ball = document.createElement('i');
        ball.className = 'ball-fx';
        zone.appendChild(ball);
        const zr = zone.getBoundingClientRect(), cr = cellEl.getBoundingClientRect();
        const x1 = cr.left - zr.left + cr.width / 2, y1 = cr.top - zr.top + cr.height / 2;
        const x0 = zr.width / 2, y0 = zr.height * 0.36;
        const glove = g.P(g.fld().pitcher).t === 'L' ? -1 : 1;
        const kn = p.type === 'KN' ? [(Math.random() - 0.5) * 22, (Math.random() - 0.5) * 18] : [0, 0];
        const mx = (x0 + x1) / 2 - bx * glove * 0.7 + kn[0], my = (y0 + y1) / 2 - by * 0.7 + kn[1];
        if (ball.animate) {
          ball.animate([
            { transform: `translate(${x0}px, ${y0}px) scale(.22)`, opacity: 0.4 },
            { transform: `translate(${mx}px, ${my}px) scale(.55)`, opacity: 1, offset: 0.55 },
            { transform: `translate(${x1}px, ${y1}px) scale(1)`, opacity: 1 },
          ], { duration: fly, easing: 'cubic-bezier(.5,0,.95,.6)', fill: 'forwards' });
        }
        timers.push(setTimeout(() => ball.remove(), fly + 120));
      }
      const swung = p.result === 'swinging' || p.result === 'foul' || p.result === 'inplay';
      if (swung && !reducedMotion()) timers.push(setTimeout(() => { const s = root.querySelector('.sil'); if (s) s.classList.add('swing'); }, Math.max(0, fly - 110)));
      timers.push(setTimeout(() => {
        if (cls === 'inplay') crack(/HR|B2|B3/.test((evs.find((e) => e.kind === 'play' && e.category) || {}).category || ''));
        else if (cls === 'foul') crack(false);
        else pop(cls === 'ball' ? 0.55 : 1);
        const dot = document.createElement('span');
        dot.className = `pd new ${RESULT_CLASS[p.result] || 'inplay'}`;
        dot.innerHTML = `${n}${pitchEv.grade ? `<i class="${pitchEv.grade}">${GRADE_LETTER[pitchEv.grade]}</i>` : ''}`;
        cellEl.appendChild(dot);
        const st = document.createElement('div');
        st.className = `stamp ${cls}`;
        st.textContent = word;
        zone.appendChild(st);
      }, fly));
      timers.push(setTimeout(done, fly + (quick ? 260 : cls === 'big' || cls === 'inplay' ? 760 : 560)));
    });
  }

  function bannerFor(evs, snap) {
    const nick = (s) => g.teams[s].nick;
    const good = (s) => s === me();
    const bat = snap.half;
    if (evs.some((e) => e.kind === 'walkoff')) return { text: 'Walk-off!', sub: `${nick(1)} win`, good: good(1), big: true };
    const runs = g.score[bat] - snap.score[bat];
    const hr = evs.find((e) => e.kind === 'play' && e.category === 'HR');
    if (g.over) return { text: g.winner === me() ? 'You win!' : 'Ballgame', sub: `${nick(g.winner)} win`, good: good(g.winner), big: true, win: g.winner === me() };
    if (hr) return { text: runs >= 4 ? 'Grand slam!' : 'Home run!', sub: runs > 1 ? `${runs} runs score` : 'Solo shot', good: good(bat), big: true };
    if (runs > 0) {
      const before = snap.score[bat] - snap.score[1 - bat], after = g.score[bat] - g.score[1 - bat];
      if (before < 0 && after === 0) return { text: 'Tie game!', sub: `${runs} run${runs > 1 ? 's' : ''} in`, good: good(bat), big: true };
      if (before <= 0 && after > 0) return { text: `${nick(bat)} lead!`, sub: `${runs} run${runs > 1 ? 's' : ''} in`, good: good(bat), big: true };
      return { text: runs > 1 ? `${runs} runs score` : 'Run scores', good: good(bat) };
    }
    if (evs.some((e) => e.kind === 'play' && /double play/.test(e.text))) return { text: 'Double play!', good: !good(bat) };
    const halfOver = snap.half !== g.half || snap.inning !== g.inning;
    const left = snap.bases.filter(Boolean).length;
    if (halfOver) {
      const k = evs.some((e) => e.kind === 'play' && /strikes out/.test(e.text));
      return { text: k ? 'Strike three!' : 'Side retired', sub: left ? `${left} left on base` : `End of the ${bat ? 'bottom' : 'top'} of the ${ordinal(snap.inning)}`, good: !good(bat) };
    }
    const steal = evs.find((e) => e.kind === 'play' && /steals|stealing|out at the plate|out at third|Double steal|picked off/.test(e.text));
    if (steal) {
      const safe = /steals|Double steal!/.test(steal.text);
      return { text: /picked off/.test(steal.text) ? 'Picked off!' : safe ? 'Safe!' : 'Caught!', sub: steal.text.replace(/[.!]$/, ''), good: safe === good(bat) };
    }
    const ch = evs.find((e) => e.kind === 'move' && e.move === 'pitch');
    if (ch) return { text: 'Pitching change', sub: g.P(ch.pid).n, good: good(ch.side), quiet: true };
    return null;
  }
  function banner(b) {
    document.querySelectorAll('.fx-banner').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = `fx-banner ${b.good ? 'good' : 'bad'} ${b.big ? 'big' : ''} ${b.quiet ? 'quiet' : ''} ${b.win ? 'win' : ''}`;
    el.innerHTML = `${esc(b.text)}${b.sub ? `<small>${esc(b.sub)}</small>` : ''}`;
    document.body.appendChild(el);
    later(() => el.remove(), b.win ? 2700 : 2000);
  }
  function confetti() {
    if (reducedMotion()) return;
    const el = document.createElement('div');
    el.className = 'confetti';
    const colors = ['#fff1cf', 'var(--away)', 'var(--home)', '#ffd27a', '#ffffff'];
    let html = '';
    for (let i = 0; i < 70; i++) {
      const left = Math.random() * 100, dur = 1.6 + Math.random() * 1.6, delay = Math.random() * 0.6;
      html += `<i style="left:${left.toFixed(1)}%;background:${colors[i % colors.length]};animation-duration:${dur.toFixed(2)}s;animation-delay:${delay.toFixed(2)}s;--dx:${((Math.random() - 0.5) * 160).toFixed(0)}px;--rot:${(360 + Math.random() * 720).toFixed(0)}deg"></i>`;
    }
    el.innerHTML = html;
    el.style.setProperty('--away', awayC);
    el.style.setProperty('--home', homeC);
    document.body.appendChild(el);
    later(() => el.remove(), 3800);
  }
  function coldOpen() {
    const sc = ctx.sc;
    const mi = mission(g, me());
    const el = document.createElement('div');
    el.className = 'coldopen';
    const first = String(sc.intro || '').match(/^.*?[.!?](\s|$)/);
    const intro = first ? first[0].trim() : String(sc.intro || '');
    el.innerHTML = `<div class="co-in"><div class="eyebrow">${esc(sc.event)}${sc.park ? ' · ' + esc(sc.park) : ''}</div>
      <h2>${esc(sc.title)}</h2><p>${esc(intro)}</p>
      <p class="goal"><span>Your goal · you manage the ${esc(myTeam().nick)}</span>${esc(mi.head)}. ${esc(mi.sub)}.</p>
      <button class="btn primary" data-co>Play ball</button></div>`;
    document.body.appendChild(el);
    const close = () => { el.classList.add('out'); later(() => el.remove(), 350); unlock(); setCrowd(pressure()); };
    el.addEventListener('click', close);
    later(() => { if (document.body.contains(el)) close(); }, 7000);
  }

  // ------------------------------------------------------------ sheets
  // Our own sheets (menu, manager, plays, ...) share the game's click handling
  // and redraw themselves when something in them changes.
  function gameSheet(kind, title, html) {
    C.sheet = kind;
    openSheet(title, html, (el) => {
      el.dataset.kind = kind;
      el.addEventListener('click', onAction);
    });
  }
  function refreshSheet() {
    const el = document.getElementById('sheet');
    if (!el || !el.dataset.kind) return;
    const k = el.dataset.kind;
    if (k === 'manager') managerSheet();
    else if (k === 'plays') playsSheet();
    else if (k === 'menu') menuSheet();
    else if (k === 'lineups') lineupSheet();
  }
  function bullpenSheet(forced) {
    const t = g.teams[me()];
    const fielding = g.half !== me();
    const can = g.canChangePitcher(me());
    const batter = fielding ? g.P(g.batter().pid) : null;
    const rows = t.pen.map((pid) => {
      const pl = g.P(pid);
      const [cls, lab] = energyLabel(t.energy[pid] ?? 1);
      const w = t.warming[pid];
      const warmLab = w === undefined ? '' : w >= 0.9 ? '<span class="energy warm">Ready</span>' : '<span class="energy warm">Warming</span>';
      const pl2 = pl.p ? pl.p.pl : null;
      let proj = '';
      if (batter && pl.p) {
        const d = paTarget(batter, pl, { lg: g.lg, tired: fatigue(pl, 0, t.energy[pid] ?? 1, false) });
        proj = ` · vs ${esc(batter.l)}: ${avg3(d.BB + d.HBP + d.B1 + d.B2 + d.B3 + d.HR)} OBP`;
      }
      const role = pl.p ? { SP: 'Starter', RP: 'Reliever', CL: 'Closer' }[pl.p.role] : '';
      return `<div class="opt"><div><div class="nm">${esc(pl.n)} <span class="muted">${pl.t}HP · ${role}</span></div>
        <div class="meta">${pl2 ? `${pl2[0]}-${pl2[1]}, ${pl2[2].toFixed(2)} ERA, ${pl2[3]} SV, ${pl2[5]} K in ${pl2[4]} IP` : ''}${proj}</div>
        <div class="meta"><span class="energy ${cls}">${lab}</span> ${warmLab}</div></div>
        <div class="actions">${w === undefined ? `<button class="btn small" data-warm="${pid}">Warm up</button>` : ''}
        ${fielding ? `<button class="btn small primary" data-bring="${pid}" ${can.ok || forced ? '' : 'disabled'}>Bring in</button>` : ''}</div></div>`;
    }).join('') || '<p class="muted">The bullpen is empty.</p>';
    const note = forced ? '<p><b>You need a pitcher.</b> Your last one came out of the game.</p>'
      : !fielding ? '<p class="muted">Your team is batting. Get someone warm now so he is ready when you take the field.</p>'
        : can.ok ? '<p class="muted">A reliever who warms up first is sharper than one rushed in cold. OBP is how often this hitter would reach base against him.</p>'
          : `<p class="muted">${esc(can.reason)}</p>`;
    C.sheet = 'bullpen';
    openSheet(forced ? 'Bring in a pitcher' : 'Bullpen', note + rows, (el) => {
      el.addEventListener('click', (e) => {
        const wb = e.target.closest('[data-warm]');
        if (wb) { g.warm(wb.dataset.warm); bullpenSheet(forced); render(); return; }
        const bb = e.target.closest('[data-bring]');
        if (bb) {
          const snap = takeSnap();
          const r = g.changePitcher(bb.dataset.bring, { side: me(), force: forced });
          if (!r.ok) { toast(r.reason); return; }
          bump('pitch');
          closeSheet();
          show(snap);
        }
      });
    }, { locked: !!forced });
  }
  function benchSheet() {
    const t = g.teams[me()];
    const batting = userBatting();
    const pit = g.pitcherObj();
    const rows = t.bench.map((pid) => {
      const pl = g.P(pid);
      const bl = pl.bl;
      let proj = '';
      if (batting && pit) {
        const d = paTarget(pl, pit, { lg: g.lg, tired: 0 });
        proj = ` · vs ${esc(pit.l)}: ${avg3(d.BB + d.HBP + d.B1 + d.B2 + d.B3 + d.HR)} OBP`;
      }
      const posList = Object.keys(pl.d || {}).filter((p) => +p >= 2).map((p) => POS_ABBR[p]).join(' ');
      const runBtns = batting ? g.bases.map((r, i) => (r ? `<button class="btn small" data-pr="${i + 1}" data-pid="${pid}">Run for ${esc(r.name)} <span class="muted">(${r.spd})</span></button>` : '')).join('') : '';
      return `<div class="opt"><div><div class="nm">${esc(pl.n)} <span class="muted">bats ${pl.b} · ${posList || 'bench'}</span></div>
        <div class="meta">${bl ? `${avg3(bl[0])}/${avg3(bl[1])}/${avg3(bl[2])}, ${bl[3]} HR, ${bl[5]} SB` : ''}${proj}</div>
        <div class="meta">${speedBadge(pl.spd)}</div></div>
        <div class="actions">${batting && !g.paStarted ? `<button class="btn small primary" data-ph="${pid}">Pinch-hit</button>` : ''}${runBtns}</div></div>`;
    }).join('') || '<p class="muted">Nobody left on the bench.</p>';
    const note = batting ? (g.paStarted ? '<p class="muted">Pinch hitters come in before the first pitch of an at-bat. You can still send in a pinch runner.</p>'
      : `<p class="muted">${esc(g.P(g.batter().pid).n)} is due up. Anyone you take out can't come back. Speed matters for pinch runners: it decides steals and scoring from second.</p>`)
      : '<p class="muted">Use Defense in the Manager menu to make defensive changes.</p>';
    C.sheet = 'bench';
    openSheet('Bench', note + rows, (el) => {
      el.addEventListener('click', (e) => {
        const ph = e.target.closest('[data-ph]');
        if (ph) {
          const r = g.pinchHit(ph.dataset.ph);
          if (!r.ok) return toast(r.reason);
          bump('ph'); closeSheet(); render(); return;
        }
        const pr = e.target.closest('[data-pr]');
        if (pr) {
          const r = g.pinchRun(+pr.dataset.pr, pr.dataset.pid);
          if (!r.ok) return toast(r.reason);
          bump('pr'); closeSheet(); C.paBases = basesKey(); render();
        }
      });
    });
  }
  function defenseSheet() {
    const t = g.teams[me()];
    const rows = t.lineup.map((x, i) => {
      if (x.pos === 1 || x.pos === 10) return '';
      const pl = g.P(x.pid);
      const rating = pl.d && pl.d[x.pos] !== undefined ? pl.d[x.pos] : 'out of position';
      const options = t.bench.map((pid) => {
        const b = g.P(pid);
        const r = b.d && b.d[x.pos] !== undefined ? b.d[x.pos] : '—';
        return `<option value="${pid}">${esc(b.n)} (${r})</option>`;
      }).join('');
      const posOpts = [2, 3, 4, 5, 6, 7, 8, 9].map((p) => `<option value="${p}" ${p === x.pos ? 'selected' : ''}>${POS_ABBR[p]}</option>`).join('');
      return `<div class="opt"><div><div class="nm">${POS_ABBR[x.pos] || '—'} · ${esc(pl.n)}</div>
        <div class="meta">Defense at ${POS_ABBR[x.pos] || '—'}: ${rating}</div></div>
        <div class="actions">
          ${options ? `<select aria-label="Replace ${esc(pl.n)}" data-repl="${i}"><option value="">Replace with…</option>${options}</select>` : ''}
          <select aria-label="Move ${esc(pl.n)}" data-move="${i}">${posOpts}</select></div></div>`;
    }).join('');
    C.sheet = 'defense';
    openSheet('Defense', `<p class="muted">Ratings are 20-80, from his fielding that season (50 is average). Players who never played a position rate poorly there.</p>${rows}`, (el) => {
      el.addEventListener('change', (e) => {
        const rep = e.target.closest('[data-repl]');
        if (rep && rep.value) {
          const slot = +rep.dataset.repl;
          const r = g.defSub(me(), slot, rep.value, t.lineup[slot].pos);
          if (!r.ok) return toast(r.reason);
          bump('def'); closeSheet(); render(); return;
        }
        const mv = e.target.closest('[data-move]');
        if (mv) { g.movePos(me(), +mv.dataset.move, +mv.value); bump('def'); defenseSheet(); render(); }
      });
    });
  }
  function managerSheet() {
    if (g.over || userBatting()) return;
    const ft = g.fld();
    const coach = coachOn();
    const b = g.P(g.batter().pid);
    const al = ft.align;
    const chip = (grp, val, label, dis = false) => `<button class="chip" data-align="${grp}:${val}" aria-pressed="${(grp === 'inf' ? al.inf : grp === 'of' ? al.of : String(!!al.shift)) === val}" ${dis ? 'disabled' : ''}>${label}${coach && DEF_HELP[`${grp}:${val}`] ? `<small>${DEF_HELP[`${grp}:${val}`]}</small>` : ''}</button>`;
    const pick = g.bases.map((r, i) => (r ? `<button class="btn small" data-pickoff="${i + 1}">Throw to ${['1st', '2nd', '3rd'][i]}</button>` : '')).join('');
    gameSheet('manager', 'Manager', `
      <div class="group"><div class="eyebrow">Infield</div>
      <div class="chips">${chip('inf', 'normal', 'Normal')}${chip('inf', 'in', 'Drawn in')}${chip('inf', 'dp', 'Double-play depth')}${chip('inf', 'corners', 'Corners in')}${chip('inf', 'lines', 'Guard the lines')}</div></div>
      <div class="group"><div class="eyebrow">Outfield</div>
      <div class="chips">${chip('of', 'normal', 'Normal')}${chip('of', 'deep', 'No doubles')}${chip('of', 'shallow', 'Shallow')}${g.rules.shift ? chip('shift', 'true', 'Shift', b.b === 'R') : ''}</div></div>
      ${g.bases.some(Boolean) ? `<div class="group"><div class="eyebrow">Runners</div><div class="chips">
        <button class="chip" data-toggle="pitchout" aria-pressed="${C.ui.pitchout}">Pitchout${coach ? '<small>Throw wide so the catcher can gun down a runner. A sure ball.</small>' : ''}</button>
        <button class="chip" data-toggle="slideStep" aria-pressed="${C.ui.slideStep}">Slide step${coach ? '<small>Quicker to the plate, a bit less control.</small>' : ''}</button></div>
        ${pick ? `<div class="actions">${pick}</div>` : ''}</div>` : ''}
      ${runnersHtml()}
      <div class="actions">
        <button class="btn" data-act="ibb">Intentional walk</button>
        <button class="btn" data-act="visit">Mound visit</button>
        <button class="btn" data-act="bullpen">Bullpen</button>
        <button class="btn" data-act="defense">Defense</button>
      </div>`);
  }
  function playsSheet() {
    if (g.over || !userBatting()) return;
    const b = g.bases;
    const s = g.count.s;
    const coach = coachOn();
    const help = (k) => (coach && SIGN_HELP[k] ? `<small>${SIGN_HELP[k]}</small>` : '');
    const ap = (val, label) => `<button class="chip" data-approach="${val}" aria-pressed="${C.ui.approach === val}">${label}${help(val)}</button>`;
    const odds = (base) => { const p = stealOdds(g, base); return p === null ? '' : `<span class="odds">${pct(p)}</span>`; };
    const os = (val, label, ok, extra = '') => `<button class="chip" data-oneshot="${val}" aria-pressed="${C.ui.oneShot === val}" ${ok ? '' : 'disabled'}>${label}${ok ? extra : ''}${help(val)}</button>`;
    gameSheet('plays', 'Signs', `
      <div class="group"><div class="eyebrow">Approach · ${g.count.b}-${g.count.s}, ${esc(countTalk(g.count).toLowerCase())}</div><div class="chips">
        ${ap('normal', 'Swing away')}${ap('take', 'Take this pitch')}${ap('takeUntilStrike', 'Take until a strike')}${ap('sitFB', 'Sit on the fastball')}${ap('protect', 'Protect the plate')}</div></div>
      <div class="group"><div class="eyebrow">Bunt</div><div class="chips">
        ${os('sac', 'Sacrifice', g.outs < 2 && (b[0] || b[1]))}${os('drag', 'Bunt for a hit', true)}${os('squeeze', 'Suicide squeeze', g.outs < 2 && b[2])}${os('safety', 'Safety squeeze', g.outs < 2 && b[2])}</div></div>
      <div class="group"><div class="eyebrow">Run</div><div class="chips">
        ${os('steal2', 'Steal 2nd', b[0] && !b[1], odds(2))}${os('steal3', 'Steal 3rd', b[1] && !b[2], odds(3))}${os('steal4', 'Steal home', b[2], odds(4))}${os('double', 'Double steal', b[0] && b[1] && !b[2])}${os('hitrun', 'Hit and run', b[0] && !b[1] && g.outs < 2 && s < 2)}${os('runhit', 'Run and hit', b[0] && !b[1])}</div></div>
      ${runnersHtml()}
      <div class="actions"><button class="btn primary" data-act="bat" data-close>Next pitch</button><button class="btn" data-act="bullpen">Bullpen</button></div>`);
  }
  function menuSheet() {
    const sw = (act, on, label, sub) => `<button data-act="${act}" aria-pressed="${on}"><span>${label}<small>${sub}</small></span><span class="sw"></span></button>`;
    const go = (act, label, sub) => `<button data-act="${act}"><span>${label}<small>${sub}</small></span><span aria-hidden="true">›</span></button>`;
    gameSheet('menu', esc(ctx.sc.title), `<p class="muted" style="margin:0">${esc(ctx.sc.event)} · you manage the ${esc(myTeam().nick)}</p>
      <div class="menu-list">
        ${sw('coach', coachOn(), 'Coach', 'Plain-English tips for new managers')}
        ${sw('auto', settings().pitches === 'key', 'Auto-play routine pitches', 'The game stops you only for the big ones')}
        ${sw('sound', soundOn(), 'Sound', 'Crowd, bat, mitt and organ')}
        ${go('box', 'Box score', 'The full line score')}
        ${go('log', 'Play-by-play', 'Every pitch and play so far')}
        ${go('lineups', 'Lineups', 'Both lineups, your bench and bullpen')}
        ${go('help', 'How to play', 'The rules of the game')}
        ${go('quit', 'Leave game', 'Back to the game page')}
      </div>`);
  }
  function lineupSheet() { gameSheet('lineups', 'Lineups', rosterTab()); }
  function logSheet() { gameSheet('log', 'Play-by-play', logHtml()); }
  function boxSheet() { gameSheet('box', 'Box score', scoreboard()); }

  // ------------------------------------------------------------ render pieces
  function pressure() {
    const w = C.wpHome;
    const close = w === null ? 0.5 : 1 - Math.abs(2 * w - 1);
    const k = keyRuns(g);
    return Math.max(0, Math.min(1, 0.65 * close + (k.tying || k.ahead ? 0.35 : 0)));
  }

  function topBar(w) {
    const from = C.shownWp === null ? w : C.shownWp;
    const tm = (s) => `<span class="g-tm ${s === me() ? 'me' : ''}"><i style="background:${s === 0 ? 'var(--away)' : 'var(--home)'}"></i><span class="nk">${esc(g.teams[s].nick)}</span><span class="ab">${esc(teamAbbr(g.teams[s].code))}</span><b class="${C.flip === s ? 'flip' : ''}">${g.score[s]}</b></span>`;
    return `<header class="g-top">
        <button class="g-icon" data-act="quit" aria-label="Leave game" title="Leave game">✕</button>
        <div class="g-score">${tm(0)}${tm(1)}<span class="g-inn">${g.over ? 'Final' : `${g.half ? '▼' : '▲'}${g.inning}`}</span></div>
        <div class="g-wp"><small>${esc(myTeam().nick)} win</small><b class="num">${w === null ? '—' : pct(w)}</b></div>
        <button class="g-icon" data-act="menu" aria-label="Menu" title="Menu">☰</button>
      </header>
      <div class="g-line" aria-hidden="true"><u></u><i data-to="${w === null ? 0 : (w * 100).toFixed(1)}" style="width:${from === null ? 0 : (from * 100).toFixed(1)}%"></i></div>`;
  }

  function scoreboard() {
    const n = Math.max(9, g.inning);
    const cols = Array.from({ length: n }, (_, i) => i + 1);
    const row = (side) => {
      const t = g.teams[side];
      const cells = cols.map((i) => {
        const v = g.line[side][i - 1];
        const cur = i === g.inning && side === g.half && !g.over;
        const future = v === undefined || (i > g.inning) || (i === g.inning && side > g.half && !g.over);
        return `<td class="${cur ? 'cur' : ''} ${future && v === undefined ? 'empty' : ''} ${i <= n - 3 ? 'early' : ''}">${v === undefined ? '' : v}</td>`;
      }).join('');
      return `<tr><td class="name ${side === me() ? 'me' : ''}"><i style="background:${side === 0 ? 'var(--away)' : 'var(--home)'}"></i>${esc(t.nick)}${side === g.half && !g.over ? '<span class="up" title="At bat"></span>' : ''}</td>${cells}
        <td class="gap"></td><td class="rhe">${g.score[side]}</td><td class="rhe">${g.hits[side]}</td><td class="rhe">${g.errors[side]}</td></tr>`;
    };
    return `<div class="board">
      <div class="board-scroll"><table aria-label="Line score">
        <thead><tr><th></th>${cols.map((i) => `<th class="${i <= n - 3 ? 'early' : ''}">${i}</th>`).join('')}<th class="gap"></th><th>R</th><th>H</th><th>E</th></tr></thead>
        <tbody>${row(0)}${row(1)}</tbody></table></div></div>`;
  }

  function noteHtml() {
    if (g.over) return '';
    const np = C.notePitch;
    if (np) return `<div class="g-ov g-note fresh"><span class="sq ${np.grade}">${GRADE_LETTER[np.grade]}</span><span>${esc(np.text)}</span><button class="x" data-act="hidenote" aria-label="Hide">×</button></div>`;
    const x = C.noteGrade;
    if (x) {
      const fresh = C.gradeFresh;
      C.gradeFresh = false;
      const tail = x.grade === 'green' ? '' : ` Best: ${esc(x.best)} (+${(x.delta * 100).toFixed(1)} pts).`;
      return `<div class="g-ov g-note ${fresh ? 'fresh' : ''}"><span class="sq ${x.grade}">${GRADE_LETTER[x.grade]}</span><span><b class="grade-word ${x.grade}">${GRADE_WORD[x.grade]}.</b> ${esc(x.mine)}.${tail}${x.why ? `<span class="why">${esc(x.why)}</span>` : ''}</span><button class="x" data-act="hidenote" aria-label="Hide">×</button></div>`;
    }
    if (coachOn() && C.tip) return `<div class="g-ov g-note"><span class="who">Coach</span><span>${esc(C.tip.text)}</span><button class="x" data-tip="${C.tip.key}" aria-label="Got it">×</button></div>`;
    return '';
  }

  function nowBatting() {
    if (g.over || g.paStarted || C.nbKey === paKeyNow() || C.noteGrade || C.notePitch || (coachOn() && C.tip)) return '';
    C.nbKey = paKeyNow();
    const b = g.P(g.batter().pid);
    const line = g.lines[g.batter().pid];
    const today = line ? `${line[2]}-for-${line[1]} today` : 'first time up today';
    return `<div class="g-ov g-nowbat" style="--tc:${g.half === 0 ? 'var(--away)' : 'var(--home)'}"><small>Now batting · ${esc(g.teams[g.half].nick)}</small><b>${esc(b.n)}</b><span>${b.bl ? `${avg3(b.bl[0])}, ${b.bl[3]} HR · ` : ''}${today}</span></div>`;
  }

  function fieldPane(fx, kr) {
    const mi = mission(g, me());
    const tags = g.over ? [] : runTags(g);
    const bulbs = (k, on) => Array.from({ length: k }, (_, i) => `<span class="bulb ${i < on ? 'on' : ''}"></span>`).join('');
    const occ = ['first', 'second', 'third'].filter((_, i) => g.bases[i]);
    const sit = `${g.half ? 'Bottom' : 'Top'} of the ${ordinal(g.inning)}, ${g.outs} out, ${occ.length === 3 ? 'bases loaded' : occ.length ? 'runner' + (occ.length > 1 ? 's' : '') + ' on ' + occ.join(' and ') : 'nobody on'}.`;
    return `<section class="g-field">${renderField(g, C.lastBall, fx, kr)}<div class="vignette"></div>
      <div class="g-ov g-mission"><b>${esc(mi.head)}</b><span>${esc([mi.sub, ...tags].filter(Boolean).join(' · '))}</span></div>
      <div class="g-ov g-bso" aria-label="Count ${g.count.b} balls ${g.count.s} strikes, ${g.outs} out">
        <div><span>B</span>${bulbs(3, g.count.b)}</div><div><span>S</span>${bulbs(2, g.count.s)}</div><div><span>O</span>${bulbs(2, g.outs)}</div>
        <em>${g.over ? 'Final' : esc(countTalk(g.count))}</em></div>
      ${nowBatting()}${noteHtml()}
      <div class="g-caption" aria-live="polite">${esc(C.lastPlay || sit)}</div>
    </section>`;
  }

  function matchLine() {
    const b = g.P(g.batter().pid), p = g.pitcherObj();
    const line = g.lines[g.batter().pid];
    const today = line ? `${line[2]}-for-${line[1]}` : '1st AB';
    const ft = g.fld();
    const ps = ft.pst[ft.pitcher] || { pitches: 0, bf: 0 };
    const tired = g.pitcherTired(ft);
    const pl = p.p ? p.p.pl : null;
    const side = battingSide(b.b, p.t);
    const hand = b.b === 'B' ? `S (${side})` : side;
    return `<div class="g-match">
      <div class="who"><div class="nm">${esc(b.n)}</div><div class="ln">Bats ${hand} · ${b.bl ? `${avg3(b.bl[0])}, ${b.bl[3]} HR` : '—'} · ${today} · ${speedBadge(b.spd)}</div></div>
      <div class="vs">vs</div>
      <div class="who right"><div class="nm">${esc(p.n)}</div><div class="ln">${p.t}HP · ${pl ? `${pl[2].toFixed(2)} ERA · ` : ''}${Math.round(ps.pitches)} pitches</div>
        <div class="meter" title="Fatigue"><i style="width:${Math.round((1 - tired) * 100)}%;background:${tired > 0.6 ? 'var(--g-red)' : tired > 0.3 ? 'var(--g-orange)' : 'var(--g-green)'}"></i></div></div></div>`;
  }

  function statusText() {
    if (g.over) return '';
    const fielding = !userBatting();
    if (C.autoOn) return `<span class="live"></span> ${C.simPA ? 'Simming the at-bat' : fielding ? "Catcher's calling the routine pitches" : 'Swinging away until a big pitch'}. <button class="linkbtn" data-act="takeover">Take over</button>`;
    if (!g.paStarted) return fielding ? 'New batter. Call the first pitch.' : 'New batter. Give the first sign.';
    const big = g.count.b === 3 || g.count.s === 2;
    return `<b>${g.count.b}-${g.count.s}</b> ${big ? 'Big pitch' : esc(countTalk(g.count))}`;
  }
  function renderStatus() {
    const el = root.querySelector('.g-stat');
    if (el) { el.innerHTML = statusText(); fitPanel(); }
  }

  function plateView(interactive) {
    const b = g.P(g.batter().pid), p = g.pitcherObj();
    const side = battingSide(b.b, p.t);
    const zm = interactive ? zoneMap(b) : null;
    const pp = paPitches();
    const perCell = {};
    // where this pitcher tends to throw in this count, for the hitter's look
    let tend = null;
    if (!interactive && C.ui.scouting && !g.over) {
      try {
        tend = new Float64Array(25);
        for (const { p: w, actual } of g.matchup().autoActual(`${g.count.b}-${g.count.s}`)) for (let a = 0; a < 25; a++) tend[a] += w * actual[a];
      } catch { tend = null; }
    }
    const look = C.ui.look;
    let cells = '';
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const v = 2 - r;
        const h = side === 'R' ? 2 - c : c - 2;
        const idx = cellIndex(h, v);
        let heat = '';
        if (zm && C.ui.scouting && inZone(idx)) {
          const z = zm[idx];
          if (z > 1.06) heat = `background: color-mix(in srgb, var(--hot) ${Math.min(55, Math.round((z - 1) * 260))}%, #121214)`;
          else if (z < 0.94) heat = `background: color-mix(in srgb, var(--cold) ${Math.min(50, Math.round((1 - z) * 260))}%, #121214)`;
        }
        const dots = pp.map((e, k) => [e, k + 1]).filter(([e]) => e.pitch.cell === idx).map(([e, k]) => {
          const j = perCell[idx] = (perCell[idx] || 0) + 1;
          const off = (j - 1) * 7;
          return `<span class="pd ${RESULT_CLASS[e.pitch.result] || 'inplay'}" style="left:calc(50% - 9.5px + ${off}px);top:calc(50% - 9.5px - ${off}px)">${k}${e.grade ? `<i class="${e.grade}">${GRADE_LETTER[e.grade]}</i>` : ''}</span>`;
        }).join('');
        const lk = look !== null && inLook(idx, look) ? 'look' : '';
        const td = tend ? `<span class="tend" style="opacity:${Math.min(0.3, tend[idx] * 2.4).toFixed(2)}"></span>` : '';
        if (interactive) {
          const label = `${spotWords(idx)}`;
          cells += `<button class="zcell ${inZone(idx) ? 'in' : ''}" style="${heat}" data-cell="${idx}" aria-pressed="${C.ui.cell === idx}" aria-label="${label}">${dots}</button>`;
        } else cells += `<button class="zcell ${inZone(idx) ? 'in' : ''} ${lk}" data-look="${idx}" aria-label="Look for a pitch ${spotWords(idx)}">${td}${dots}</button>`;
      }
    }
    const color = `color-mix(in srgb, ${g.half === 0 ? 'var(--away)' : 'var(--home)'} 50%, #17171a)`;
    const sideWord = b.b === 'B' ? `Switch · ${side === 'L' ? 'lefty' : 'righty'} here` : side === 'L' ? 'Bats left' : 'Bats right';
    const cap = interactive ? "Catcher's view"
      : look !== null ? `Looking <b>${spotWords(look)}</b>` : (coachOn() ? 'Tap the zone to look for a pitch there' : "Catcher's view");
    return `<div class="plate-view ${side}">
      <div class="sil">${batterSilhouette(side, color)}<span class="sil-lab">${sideWord}</span></div>
      <div class="zone-box">
        <div class="zone-lab"><span>${side === 'R' ? 'Inside' : 'Away'}</span><span>${side === 'R' ? 'Away' : 'Inside'}</span></div>
        <div class="zone" role="group" aria-label="${interactive ? 'Pitch location, catcher\'s view' : 'Where to look for a pitch'}">${cells}<span class="sz"></span></div>
        <div class="${interactive ? 'zone-cap' : 'look-cap'}">${cap}</div>
      </div></div>`;
  }

  function runnersHtml() {
    const lines = g.bases.map((r, i) => {
      if (!r) return '';
      const nextBase = [2, 3, 4][i];
      const open = i === 2 || !g.bases[i + 1];
      const odds = open ? stealOdds(g, nextBase) : null;
      return `<div class="runner-line"><span class="base">${['1B', '2B', '3B'][i]}</span><b>${esc(r.name)}</b>${speedBadge(r.spd)}
        ${odds !== null ? `<span class="muted">steal ${['2nd', '3rd', 'home'][i]}: <b class="num">${pct(odds)}</b> safe</span>` : ''}</div>`;
    }).join('');
    return lines ? `<div class="runners-row"><div class="eyebrow">On base</div>${lines}</div>` : '';
  }

  function sideCol() {
    if (g.over) return '';
    const coach = coachOn();
    if (!userBatting()) {
      const M = g.matchup();
      const types = M.types.map((t, i) => `<button class="ptype" data-ti="${i}" aria-pressed="${C.ui.ti === i}"><span class="kbd k">${i + 1}</span><b>${esc((PITCH_TYPES[t.key] || {}).short || t.key)}</b><small>${Math.round(t.q)} grade · ${t.use}%${coach && PITCH_HELP[t.key] ? `<span class="help"> · ${PITCH_HELP[t.key]}</span>` : ''}</small></button>`).join('');
      return `<div class="g-side"><div class="g-stat">${statusText()}</div><div class="ptypes">${types}</div></div>`;
    }
    const ap = (val, small) => `<button data-approach="${val}" aria-pressed="${C.ui.approach === val}">${APPROACH[val]}${coach ? `<small>${small}</small>` : ''}</button>`;
    return `<div class="g-side"><div class="g-stat">${statusText()}</div>
      <div class="appr">${ap('normal', 'Swing at good pitches')}${ap('take', "Don't swing this pitch")}${ap('sitFB', 'Look fastball, drive it')}${ap('protect', 'Shorten up, make contact')}</div></div>`;
  }

  function panel() {
    if (g.over) return '<section class="g-panel"></section>';
    return `<section class="g-panel"><div class="g-board">${scoreboard()}</div>${matchLine()}
      <div class="g-ab">${plateView(!userBatting())}${sideCol()}</div></section>`;
  }

  function dock() {
    if (g.over) return '<footer class="g-dock"></footer>';
    if (!userBatting()) {
      const t = g.matchup().types[C.ui.ti];
      const tname = t ? ((PITCH_TYPES[t.key] || {}).short || t.key) : '';
      return `<footer class="g-dock">
        <button class="btn primary" data-act="pitch" ${C.ui.cell === null ? 'disabled' : ''}>Throw it<small>${C.ui.cell === null ? 'Tap a spot first' : `${esc(tname)} ${esc(spotWords(C.ui.cell))}`}</small></button>
        <button class="btn ${C.ui.cell === null ? 'lit' : ''}" data-act="catcher">Catcher's call<small>He picks it</small></button>
        <button class="btn" data-act="manager">Manager<small>Bullpen &amp; more</small></button>
        <button class="btn icon" data-act="sim" aria-label="Sim this at-bat" title="Sim this at-bat">⏭</button>
      </footer>`;
    }
    const o = C.ui.oneShot;
    const sum = o ? ONESHOT[o] : `${APPROACH[C.ui.approach]}${C.ui.look !== null && C.ui.approach !== 'take' ? ', look ' + spotWords(C.ui.look) : ''}`;
    return `<footer class="g-dock">
      <button class="btn primary" data-act="bat">Next pitch<small>${esc(sum)}</small></button>
      <button class="btn ${o ? 'has-sign' : ''}" data-act="plays">Signs<small>${o ? esc(ONESHOT[o]) : 'Bunt · steal · H&R'}</small></button>
      <button class="btn" data-act="bench">Bench<small>Pinch-hit · run</small></button>
      <button class="btn icon" data-act="sim" aria-label="Sim this at-bat" title="Sim this at-bat">⏭</button>
    </footer>`;
  }

  function rosterTab() {
    const t = g.teams[me()];
    const tab = C.ui.tab;
    let body = '';
    if (tab === 'lineup' || tab === 'opp') {
      const team = tab === 'opp' ? g.teams[1 - me()] : t;
      const upSlot = g.half === team.side ? team.slot : -1;
      body = team.lineup.map((x, i) => {
        const pl = g.P(x.pid);
        const ln = g.lines[x.pid];
        return `<div class="pl ${i === upSlot ? 'up' : ''}"><span class="pos">${POS_ABBR[x.pos] || ''}</span><div><div class="nm">${i + 1}. ${esc(pl.n)}</div>
          <div class="sub">${pl.bl ? `${avg3(pl.bl[0])}/${avg3(pl.bl[1])}/${avg3(pl.bl[2])}, ${pl.bl[3]} HR` : ''}${ln ? ` · today ${ln[2]}-${ln[1]}` : ''}</div></div>
          <span class="sub">${speedBadge(pl.spd)}</span></div>`;
      }).join('');
      if (team.dh) body += `<div class="pl"><span class="pos">P</span><div><div class="nm">${esc(g.P(team.pitcher).n)}</div><div class="sub">pitching</div></div><span class="sub">${g.P(team.pitcher).t}HP</span></div>`;
    } else if (tab === 'bench') {
      body = t.bench.map((pid) => {
        const pl = g.P(pid);
        return `<div class="pl"><span class="pos">${POS_ABBR[pl.pr] || ''}</span><div><div class="nm">${esc(pl.n)}</div><div class="sub">${pl.bl ? `${avg3(pl.bl[0])}/${avg3(pl.bl[1])}/${avg3(pl.bl[2])}, ${pl.bl[3]} HR, ${pl.bl[5]} SB` : ''} · bats ${pl.b}</div></div><span class="sub">${speedBadge(pl.spd)}</span></div>`;
      }).join('') || '<p class="muted">Empty.</p>';
    } else {
      body = t.pen.map((pid) => {
        const pl = g.P(pid);
        const [cls, lab] = energyLabel(t.energy[pid] ?? 1);
        const w = t.warming[pid];
        return `<div class="pl"><span class="pos">${pl.t}</span><div><div class="nm">${esc(pl.n)}</div><div class="sub">${pl.p ? `${pl.p.pl[2].toFixed(2)} ERA, ${pl.p.pl[3]} SV` : ''}</div></div>
          <span><span class="energy ${cls}">${lab}</span>${w !== undefined ? ` <span class="energy warm">${w >= 0.9 ? 'Ready' : 'Warming'}</span>` : ''}</span></div>`;
      }).join('') || '<p class="muted">Empty.</p>';
    }
    const tb = (k, l) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`;
    return `<div class="tabs" role="tablist">${tb('lineup', 'Lineup')}${tb('bench', 'Bench')}${tb('pen', 'Bullpen')}${tb('opp', esc(g.teams[1 - me()].nick))}</div>
      <div class="roster">${body}</div>`;
  }

  function logHtml() {
    const evs = g.log.filter((e) => ['play', 'move', 'halfStart', 'history', 'pitch', 'walkoff', 'note', 'decision'].includes(e.kind) && !e.quiet);
    const out = [];
    for (const e of evs.slice(-120)) {
      let cls = 'ev';
      if (e.kind === 'play' || e.kind === 'walkoff') cls += ' play';
      if (e.kind === 'move') cls += ' move';
      if (e.kind === 'history') cls += ' hist';
      if (e.kind === 'halfStart') cls += ' half';
      const tag = e.kind === 'pitch' ? `${e.count.b}-${e.count.s}` : `${e.half ? 'B' : 'T'}${e.inning}`;
      out.push(`<div class="${cls}"><span class="tag">${tag}</span><span>${esc(e.text)}${e.kind === 'history' ? ' <span class="muted">(real game)</span>' : ''}${e.grade ? ` <span class="sq ${e.grade}">${GRADE_LETTER[e.grade]}</span>` : ''}</span></div>`);
    }
    return `<div class="log">${out.reverse().join('')}</div>`;
  }

  function render() {
    const fx = C.fx;
    C.fx = null;
    const w = C.wpHome === null ? null : forSide(C.wpHome, me());
    if (!C.tip || C.tip.at !== paKeyNow() + g.count.b + g.count.s) {
      const t = coachOn() ? tipFor(g, me()) : null;
      C.tip = t ? { ...t, at: paKeyNow() + g.count.b + g.count.s } : null;
    }
    const kr = g.over ? {} : keyRuns(g);
    const pr = pressure();
    root.innerHTML = `<div class="gs" style="--away:${awayC};--home:${homeC};--mine:${me() ? homeC : awayC};--pressure:${pr.toFixed(2)}">
      ${topBar(w)}${fieldPane(fx, kr)}${panel()}${dock()}</div>`;
    C.flip = null;
    const bar = root.querySelector('.g-line i');
    if (bar) requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = bar.dataset.to + '%'; }));
    C.shownWp = w;
    setCrowd(pr);
    fitPanel();
  }

  // The zone's size in the stylesheet is a guess from the window size. Measure:
  // if the at-bat still doesn't fit (Safari's toolbars, Stage Manager windows,
  // a long status line, five pitch types), shrink the zone until it does.
  function fitPanel() {
    const gs = root.querySelector('.gs'), p = gs && gs.querySelector('.g-panel'), z = p && p.querySelector('.zone');
    if (!z) return;
    gs.style.removeProperty('--zc');
    for (let i = 0; i < 4; i++) {
      const over = Math.max(p.scrollHeight - p.clientHeight, gs.scrollHeight - gs.clientHeight);
      const cell = (z.offsetHeight - 22) / 5;
      if (over <= 0 || cell <= 20) return;
      gs.style.setProperty('--zc', Math.max(20, Math.floor(cell - over / 5 - 0.5)) + 'px');
    }
  }

  // ------------------------------------------------------------ events
  function onAction(e) {
    const t = e.target.closest('button, input');
    if (C.busy) {
      if (t && (t.closest('.g-panel, .g-dock') || t.dataset.act === 'takeover')) takeOver();
      if (C.skip) C.skip();
      return;
    }
    if (!t) return;
    unlock();
    const d = t.dataset;
    const inSheet = !!t.closest('#sheet');
    if (inSheet && (d.close !== undefined && !d.act)) return;
    const inDesk = !!t.closest('.g-panel, .g-dock, #sheet');
    if (C.autoOn && inDesk && d.act !== 'takeover') takeOver();
    const redraw = () => { render(); if (inSheet) refreshSheet(); };
    if (d.act === 'takeover') { takeOver(); return render(); }
    if (d.tip) { markSeen(d.tip); C.tip = null; return render(); }
    if (d.ti !== undefined) { C.ui.ti = +d.ti; return render(); }
    if (d.cell !== undefined) { C.ui.cell = +d.cell; return render(); }
    if (d.look !== undefined) {
      // the middle of the zone, or the same spot again, means no look
      const idx = +d.look;
      const h = Math.max(-1, Math.min(1, cellH(idx))), v = Math.max(-1, Math.min(1, cellV(idx)));
      const lk = h || v ? cellIndex(h, v) : null;
      C.ui.look = C.ui.look === lk ? null : lk;
      if (C.ui.approach === 'take') C.ui.approach = 'normal';
      return render();
    }
    if (d.tab) { C.ui.tab = d.tab; return redraw(); }
    if (d.approach) { C.ui.approach = d.approach; return redraw(); }
    if (d.oneshot) { C.ui.oneShot = C.ui.oneShot === d.oneshot ? null : d.oneshot; return redraw(); }
    if (d.toggle) { C.ui[d.toggle] = !C.ui[d.toggle]; return redraw(); }
    if (d.align) {
      const [grp, val] = d.align.split(':');
      if (grp === 'shift') g.setAlign(me(), { shift: !g.teams[me()].align.shift });
      else g.setAlign(me(), { [grp]: val });
      return redraw();
    }
    if (d.pickoff) {
      closeSheet();
      const snap = takeSnap();
      g.pickoff(+d.pickoff);
      C.manualPA = paKeyNow();
      return settle(snap, { noBeat: true });
    }
    switch (d.act) {
      case 'pitch': return doPitch(false, false);
      case 'catcher': return doPitch(true, false);
      case 'bat': if (inSheet) closeSheet(); return doBat(false);
      case 'sim': return simAtBat();
      case 'hidenote': C.noteGrade = null; C.notePitch = null; return render();
      case 'ibb': {
        closeSheet();
        if (!C.graded) gradeDef(true);
        bump('ibb');
        const snap = takeSnap();
        g.ibb();
        return settle(snap, { noBeat: true });
      }
      case 'visit': {
        const r = g.visit();
        if (!r.ok) toast(r.reason); else { bump('visit'); toast('Mound visit: settles him down for a hitter or two.'); }
        return redraw();
      }
      case 'manager': return managerSheet();
      case 'plays': return playsSheet();
      case 'menu': return menuSheet();
      case 'box': return boxSheet();
      case 'log': return logSheet();
      case 'lineups': return lineupSheet();
      case 'bullpen': return bullpenSheet(false);
      case 'bench': return benchSheet();
      case 'defense': return defenseSheet();
      case 'coach': setCoach(!coachOn()); C.tip = null; return redraw();
      case 'auto': setSetting('pitches', settings().pitches === 'key' ? 'every' : 'key'); redraw(); return maybeAuto();
      case 'sound': { const on = toggleSound(); if (on) setCrowd(pressure()); return redraw(); }
      case 'help': closeSheet(); return ctx.onHelp();
      case 'quit': closeSheet(); return ctx.onQuit();
      default:
    }
  }
  root.onclick = onAction;
  const onKey = (e) => {
    if (document.getElementById('sheet') || C.done) return;
    const co = document.querySelector('.coldopen');
    if (co) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); co.click(); } return; }
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    if (C.busy && (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) { e.preventDefault(); if (C.skip) C.skip(); return; }
    if (C.busy) return;
    const fielding = !userBatting();
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.closest && e.target.closest('button') && e.key === ' ') return;
      e.preventDefault();
      unlock();
      if (C.autoOn) { takeOver(); return render(); }
      if (fielding) return doPitch(C.ui.cell === null, false);
      return doBat(false);
    }
    if (fielding && (e.key === 'c' || e.key === 'C')) { if (C.autoOn) takeOver(); unlock(); return doPitch(true, false); }
    if (fielding && /^[1-6]$/.test(e.key)) {
      const i = +e.key - 1;
      if (i < g.matchup().types.length) { C.ui.ti = i; render(); }
      return;
    }
    if (fielding && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const b = g.P(g.batter().pid), p = g.pitcherObj();
      const side = battingSide(b.b, p.t);
      const cur = C.ui.cell === null ? cellIndex(0, 0) : C.ui.cell;
      let h = cellH(cur), v = cellV(cur);
      const dir = side === 'R' ? -1 : 1; // screen right is away from a righty
      if (C.ui.cell !== null) {
        if (e.key === 'ArrowUp') v = Math.min(2, v + 1);
        if (e.key === 'ArrowDown') v = Math.max(-2, v - 1);
        if (e.key === 'ArrowLeft') h = Math.max(-2, Math.min(2, h - dir));
        if (e.key === 'ArrowRight') h = Math.max(-2, Math.min(2, h + dir));
      }
      C.ui.cell = cellIndex(h, v);
      render();
    }
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', fitPanel);
  C.destroy = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', fitPanel);
    C.timers.forEach(clearTimeout);
    clearTimeout(C.autoTimer);
    C.done = true;
    stopCrowd();
    document.body.classList.remove('in-game');
    document.querySelectorAll('.fx-banner, .coldopen, .confetti').forEach((el) => el.remove());
  };
  setupPA();
  refreshWp();
  render();
  if (g.over) finish();
  else {
    coldOpen();
    if (g.pending && g.pending.kind === 'needPitcher' && g.pending.side === me()) bullpenSheet(true);
  }
  return C;
}

Object.assign(exports, { energyLabel, spotWords, mountGame, TACTIC_LABEL, GRADE_WORD, GRADE_LETTER, GRADE_EMOJI });
});
__def("ui/share.js", function (exports) {
// A picture of a finished game for sharing, drawn on a canvas in the game's
// own look (no image files), plus the share sheet with a text fallback.
const { copyText } = __req("ui/util.js");

const GRADE = { green: ['#3ad07e', 'A'], yellow: ['#ffd23f', 'B'], orange: ['#ff8c32', 'C'], red: ['#ff4f5e', 'F'] };

function wrap(ctx, text, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// card: { event, title, team, won, score: [mine, theirs], grades: [...], stars: [0|1 x3], color, url }
async function resultCard(card) {
  try {
    await Promise.all(['800 80px Fraunces', 'italic 800 60px Fraunces', '900 150px Doto', '800 28px "Libre Franklin"'].map((f) => document.fonts.load(f)));
  } catch { /* fallback fonts are fine */ }
  const W = 1080, H = 1080;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W / 2, -80, 40, W / 2, -80, 900);
  glow.addColorStop(0, 'rgba(255,241,207,.28)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);
  const grass = c.createRadialGradient(W / 2, H + 260, 60, W / 2, H + 260, 700);
  grass.addColorStop(0, 'rgba(46,110,59,.55)');
  grass.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = grass;
  c.fillRect(0, 0, W, H);
  // brand
  c.fillStyle = '#f2efe6';
  c.font = 'italic 800 60px Fraunces, Georgia, serif';
  c.fillText('Last Licks', 80, 140);
  c.fillStyle = '#9a958b';
  c.font = '800 26px "Libre Franklin", Arial, sans-serif';
  c.fillText('MANAGE THE NINTH', 80, 182);
  // the game
  c.fillStyle = '#9a958b';
  c.font = '800 28px "Libre Franklin", Arial, sans-serif';
  c.fillText(String(card.event).toUpperCase(), 80, 290);
  c.fillStyle = '#f2efe6';
  c.font = '800 80px Fraunces, Georgia, serif';
  let y = 380;
  for (const line of wrap(c, card.title, W - 160).slice(0, 2)) { c.fillText(line, 80, y); y += 92; }
  // the result, in bulbs
  c.font = '900 150px Doto, monospace';
  c.shadowColor = 'rgba(255,222,160,.75)';
  c.shadowBlur = 30;
  c.fillStyle = '#fff1cf';
  c.fillText(`${card.won ? 'WON' : 'LOST'} ${card.score[0]}-${card.score[1]}`, 72, y + 150);
  c.shadowBlur = 0;
  c.fillStyle = '#9a958b';
  c.font = '700 30px "Libre Franklin", Arial, sans-serif';
  c.fillText(`Managing the ${card.team}`, 80, y + 205);
  // grades
  let x = 80;
  const gy = y + 260;
  for (const gr of card.grades.slice(0, 12)) {
    const [col, letter] = GRADE[gr];
    c.fillStyle = col;
    c.beginPath();
    c.roundRect ? c.roundRect(x, gy, 62, 62, 12) : c.rect(x, gy, 62, 62);
    c.fill();
    c.fillStyle = '#000';
    c.font = '900 34px "Libre Franklin", Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText(letter, x + 31, gy + 44);
    c.textAlign = 'left';
    x += 74;
  }
  // stars
  c.font = '48px Arial, sans-serif';
  card.stars.forEach((on, i) => {
    c.fillStyle = on ? '#fff1cf' : '#3a3833';
    c.shadowColor = on ? 'rgba(255,222,160,.8)' : 'transparent';
    c.shadowBlur = on ? 18 : 0;
    c.fillText('★', 80 + i * 60, gy + 150);
  });
  c.shadowBlur = 0;
  // footer
  c.fillStyle = card.color || '#fff1cf';
  c.fillRect(80, H - 120, 6, 44);
  c.fillStyle = '#f2efe6';
  c.font = '700 30px "Libre Franklin", Arial, sans-serif';
  c.fillText('Can you manage it better?', 104, H - 92);
  c.fillStyle = '#9a958b';
  c.font = '600 24px "Libre Franklin", Arial, sans-serif';
  c.fillText(card.url.replace(/^https?:\/\//, ''), 104, H - 60);
  return new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
}

// Share sheet with the picture where the device supports it, else the text.
async function shareResult({ text, url, blob }) {
  try {
    if (blob && navigator.canShare) {
      const file = new File([blob], 'last-licks.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: `${text}\n${url}` });
        return 'shared';
      }
    }
    if (navigator.share) {
      await navigator.share({ text, url });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  return (await copyText(`${text}\n${url}`)) ? 'copied' : 'failed';
}

Object.assign(exports, { resultCard, shareResult });
});
__def("ui/sound.js", function (exports) {
// Ballpark sounds synthesized with WebAudio: no audio files. Nothing plays
// until the player has clicked something (browsers require a gesture), and the
// whole thing is off when muted.
const { settings, setSetting } = __req("ui/store.js");

let ctx = null;
let master = null;
let crowd = null;

function audio() {
  if (!settings().sound) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

const soundOn = () => !!settings().sound;
function toggleSound() {
  const on = !settings().sound;
  setSetting('sound', on);
  if (!on) stopCrowd();
  else audio();
  return on;
}
// call from any click handler: unlocks audio on browsers that need a gesture
function unlock() { if (settings().sound) audio(); }

function noiseBuffer(ac, seconds, color = 'white') {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}

function burst(ac, { t = 0, dur = 0.08, type = 'bandpass', freq = 1500, q = 1, gain = 0.6, attack = 0.002 }) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur + 0.05);
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  const t0 = ac.currentTime + t;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

function tone(ac, { t = 0, freq = 440, to = null, dur = 0.2, type = 'sine', gain = 0.2, attack = 0.005 }) {
  const o = ac.createOscillator();
  o.type = type;
  const t0 = ac.currentTime + t;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

// the catcher's mitt
function pop(strength = 1) {
  const ac = audio(); if (!ac) return;
  burst(ac, { dur: 0.06, freq: 1800, q: 0.9, gain: 0.5 * strength });
  tone(ac, { freq: 180, to: 90, dur: 0.09, gain: 0.35 * strength });
}
// wood on leather; harder contact is louder and brighter
function crack(hard = false) {
  const ac = audio(); if (!ac) return;
  burst(ac, { dur: hard ? 0.12 : 0.08, type: 'highpass', freq: hard ? 1800 : 1200, q: 0.7, gain: hard ? 0.9 : 0.6 });
  tone(ac, { freq: hard ? 2600 : 2100, to: 900, dur: 0.05, type: 'triangle', gain: 0.25 });
  tone(ac, { freq: 140, to: 70, dur: 0.07, gain: 0.3 });
}
// the crowd reacts: +1 cheer, -1 groan, size 0..1
function crowdReact(sign, size = 0.5) {
  const ac = audio(); if (!ac) return;
  const dur = 0.9 + size * 1.6;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur + 0.1, 'brown');
  const f = ac.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = 0.6;
  const t0 = ac.currentTime;
  if (sign > 0) { f.frequency.setValueAtTime(500, t0); f.frequency.linearRampToValueAtTime(900 + 500 * size, t0 + 0.25); }
  else { f.frequency.setValueAtTime(700, t0); f.frequency.exponentialRampToValueAtTime(260, t0 + dur); }
  const g = ac.createGain();
  const peak = (sign > 0 ? 0.35 : 0.22) + 0.45 * size;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + (sign > 0 ? 0.12 : 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.1);
}
// the ballpark organ: "Charge!"
function charge() {
  const ac = audio(); if (!ac) return;
  const notes = [[392, 0], [523, 0.13], [659, 0.26], [784, 0.39], [659, 0.62], [784, 0.75]];
  for (const [f, t] of notes) {
    const d = t >= 0.75 ? 0.5 : 0.12;
    tone(ac, { t, freq: f, dur: d, type: 'square', gain: 0.06 });
    tone(ac, { t, freq: f * 2, dur: d, type: 'sine', gain: 0.05 });
  }
}
// a low organ sting for the end of a game
function sting(won) {
  const ac = audio(); if (!ac) return;
  const chord = won ? [523, 659, 784, 1047] : [220, 262, 311];
  for (const f of chord) tone(ac, { freq: f, dur: won ? 1.2 : 1.0, type: 'triangle', gain: 0.07, attack: 0.03 });
}

// A steady crowd murmur under the game; louder when the pressure is up.
function setCrowd(level) {
  const ac = audio();
  if (!ac) return;
  if (!crowd) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac, 4, 'brown');
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 650;
    const g = ac.createGain();
    g.gain.value = 0.0001;
    src.connect(f); f.connect(g); g.connect(master);
    src.start();
    crowd = { src, g, f };
  }
  const v = 0.03 + 0.14 * Math.max(0, Math.min(1, level));
  crowd.g.gain.setTargetAtTime(v, ac.currentTime, 0.6);
  crowd.f.frequency.setTargetAtTime(550 + 500 * level, ac.currentTime, 0.6);
}
function stopCrowd() {
  if (!crowd || !ctx) return;
  try { crowd.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2); crowd.src.stop(ctx.currentTime + 0.8); } catch { /* already stopped */ }
  crowd = null;
}

Object.assign(exports, { toggleSound, unlock, pop, crack, crowdReact, charge, sting, setCrowd, stopCrowd, soundOn });
});
__def("ui/store.js", function (exports) {
// Per-viewer records kept in this browser. Every read and write is guarded:
// private windows and blocked storage just mean nothing is remembered.

const KEY = 'lastlicks.v1';
const blankSettings = () => ({ calls: 'manual', sound: true, coach: 'auto', pace: 'normal', seen: {} });
const blank = () => ({
  played: {}, daily: {}, streak: { cur: 0, best: 0, lastDay: 0 },
  survivor: { best: 0, run: null },
  totals: { games: 0, wins: 0, calls: { green: 0, yellow: 0, orange: 0, red: 0 },
    moves: { pitch: 0, ph: 0, pr: 0, bunt: 0, steal: 0, hitrun: 0, ibb: 0, visit: 0, def: 0, squeeze: 0 } },
  settings: blankSettings(),
});

let mem = null;
function load() {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(KEY);
    const got = raw ? JSON.parse(raw) : {};
    mem = { ...blank(), ...got };
    mem.settings = { ...blankSettings(), ...(got.settings || {}) };
    delete mem.settings.theme;
  } catch {
    mem = blank();
  }
  return mem;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* not remembered */ }
}
function settings() { return load().settings; }
function setSetting(k, v) { load().settings[k] = v; save(); }

// record a finished game
function recordGame(r) {
  const s = load();
  const p = s.played[r.id] || (s.played[r.id] = { w: 0, l: 0 });
  if (r.won) p.w++; else p.l++;
  p.last = { won: r.won, score: r.score, side: r.side, grades: r.grades, when: Date.now() };
  s.totals.games++;
  if (r.won) s.totals.wins++;
  for (const gr of r.grades) s.totals.calls[gr] = (s.totals.calls[gr] || 0) + 1;
  for (const [k, v] of Object.entries(r.moves || {})) s.totals.moves[k] = (s.totals.moves[k] || 0) + v;
  if (r.mode === 'daily' && !s.daily[r.day]) {
    s.daily[r.day] = { id: r.id, won: r.won, score: r.score, side: r.side, grades: r.grades };
    if (s.streak.lastDay === r.day - 1) s.streak.cur++;
    else if (s.streak.lastDay !== r.day) s.streak.cur = 1;
    s.streak.lastDay = r.day;
    s.streak.best = Math.max(s.streak.best, s.streak.cur);
  }
  save();
}

// Stars for one game: [won, no costly calls, out-managed the real manager].
// Each scenario keeps the best set earned in any game.
function recordStars(id, stars) {
  const s = load();
  const p = s.played[id] || (s.played[id] = { w: 0, l: 0 });
  const prev = p.stars || [0, 0, 0];
  p.stars = prev.map((v, i) => (v || stars[i] ? 1 : 0));
  save();
  return p.stars;
}
const starCount = (id) => {
  const p = load().played[id];
  return p && p.stars ? p.stars.reduce((a, b) => a + b, 0) : 0;
};
function totalStars() {
  return Object.values(load().played).reduce((n, p) => n + (p.stars ? p.stars.reduce((a, b) => a + b, 0) : 0), 0);
}

// A save code: the whole record as text, to copy somewhere safe and paste
// back after Safari clears the site's data or on another device.
function exportCode() {
  const json = JSON.stringify(load());
  return 'LL1.' + btoa(unescape(encodeURIComponent(json)));
}
function importCode(code) {
  try {
    const raw = String(code || '').trim().replace(/^LL1\./, '');
    const got = JSON.parse(decodeURIComponent(escape(atob(raw))));
    if (!got || typeof got !== 'object' || !got.totals || !got.played) return false;
    mem = { ...blank(), ...got };
    mem.settings = { ...blankSettings(), ...(got.settings || {}) };
    save();
    return true;
  } catch {
    return false;
  }
}

function managerStyle(t) {
  const g = Math.max(1, t.games);
  const m = t.moves;
  const per = (k) => (m[k] || 0) / g;
  if (t.games < 3) return null;
  const styles = [
    { name: 'Sparky Anderson', why: 'Captain Hook: you go to the bullpen early and often.', score: per('pitch') * 1.4 },
    { name: 'Whitey Herzog', why: 'Speed and pressure: steals and hit-and-runs.', score: (per('steal') + per('hitrun')) * 1.6 },
    { name: 'Billy Martin', why: 'Squeezes, bunts and nerve.', score: (per('squeeze') * 2 + per('bunt')) * 1.5 },
    { name: 'Casey Stengel', why: 'You play the matchups off the bench.', score: (per('ph') + per('pr')) * 1.2 },
    { name: 'Tony La Russa', why: 'Every matchup managed: bullpen moves and pinch hitters.', score: (per('pitch') + per('ph')) * 0.9 },
    { name: 'Joe Maddon', why: 'Unconventional: walks, shifts and defensive tinkering.', score: (per('ibb') + per('def')) * 1.5 },
    { name: 'Earl Weaver', why: 'No bunts, no gimmicks. Pitching, defense and the three-run homer.', score: 0.55 - per('bunt') - per('steal') * 0.5 },
  ];
  styles.sort((a, b) => b.score - a.score);
  return styles[0];
}

Object.assign(exports, { load, save, settings, setSetting, recordGame, recordStars, totalStars, exportCode, importCode, managerStyle, starCount });
});
__def("ui/teams.js", function (exports) {
// Team colors tuned to read on a black background: [primary, alternate].
// Used as accents so every game wears its two teams' colors.

const COLORS = {
  ANA: ['#e0464b', '#c4ced4'], CAL: ['#e0464b', '#5b7fc4'], ARI: ['#d43a52', '#3fb5a8'],
  ATL: ['#d8424f', '#5b7fc4'], BAL: ['#f06a26', '#c4ced4'], BOS: ['#d9474c', '#5b7fc4'],
  BRO: ['#3f7fd8', '#c4ced4'], BSN: ['#cf4a43', '#5b7fc4'], CHA: ['#c4ced4', '#8e9aa6'],
  CHN: ['#3f6fdb', '#e0484a'], CIN: ['#e2343f', '#c4ced4'], CLE: ['#d6404e', '#5b7fc4'],
  COL: ['#8b63d6', '#c4ced4'], DET: ['#f27a3c', '#5b7fc4'], FLO: ['#18aab3', '#f2a03a'],
  MIA: ['#25a9e6', '#f05a5a'], HOU: ['#f07a2a', '#5b7fc4'], KCA: ['#3f78d8', '#c9a646'],
  LAN: ['#3f86e0', '#e84a50'], MIL: ['#e8b62e', '#5b7fc4'], MIN: ['#d63f58', '#5b7fc4'],
  MLN: ['#d2443f', '#5b7fc4'], MON: ['#3f7ad8', '#e04a4f'], NY1: ['#f46a2c', '#c4ced4'],
  NYA: ['#6f92d6', '#c4ced4'], NYN: ['#3b6fe0', '#f57a32'], OAK: ['#2fa865', '#efb21e'],
  PHA: ['#6f92d6', '#c4ced4'], PHI: ['#e6343f', '#5b7fc4'], PIT: ['#f2bb2b', '#c4ced4'],
  SDN: ['#d2a33a', '#c4ced4'], SEA: ['#24a69d', '#5b7fc4'], SFN: ['#f46a2c', '#c4ced4'],
  SLA: ['#d47a35', '#c4ced4'], SLN: ['#da3a52', '#f2c94c'], TBA: ['#8fbce6', '#f2c94c'],
  TEX: ['#3f72de', '#e04a4f'], TOR: ['#3f86de', '#c4ced4'], WAS: ['#d93a43', '#5b7fc4'],
  WS1: ['#d24a4a', '#5b7fc4'],
};
const FALLBACK = [['#5b8ee0', '#c4ced4'], ['#e0604f', '#c4ced4']];

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function distance(a, b) {
  const [r1, g1, b1] = hexRgb(a), [r2, g2, b2] = hexRgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

// The short names fans know, where Retrosheet's codes differ.
const ABBR = {
  ANA: 'LAA', CAL: 'CAL', CHA: 'CWS', CHN: 'CHC', KCA: 'KC', LAN: 'LAD', NYA: 'NYY', NYN: 'NYM', NY1: 'NYG',
  SDN: 'SD', SFN: 'SF', SLN: 'STL', SLA: 'SLB', TBA: 'TB', WAS: 'WSH', WS1: 'WAS', FLO: 'FLA', MLN: 'MIL', BSN: 'BSN',
};
const teamAbbr = (code) => ABBR[code] || code;

// Colors for a matchup; the visitors switch to their alternate if the two clash.
function teamColors(visCode, homeCode) {
  const v = COLORS[visCode] || FALLBACK[0];
  const h = COLORS[homeCode] || FALLBACK[1];
  let away = v[0];
  if (distance(away, h[0]) < 90) away = distance(v[1], h[0]) >= 90 ? v[1] : '#c4ced4';
  return [away, h[0]];
}

Object.assign(exports, { teamColors, teamAbbr });
});
__def("ui/util.js", function (exports) {
// Small DOM and formatting helpers.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const avg3 = (x) => (x >= 1 ? x.toFixed(3) : x.toFixed(3).replace(/^0/, ''));

function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd);
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function toast(msg, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

function openSheet(title, bodyHtml, onMount, opts = {}) {
  closeSheet();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.id = 'sheet';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2>${opts.locked ? '' : '<button class="btn small" data-close>Close</button>'}</header>
    <div class="body">${bodyHtml}</div></div>`;
  scrim.addEventListener('click', (e) => {
    if (!opts.locked && (e.target === scrim || e.target.closest('[data-close]'))) closeSheet();
  });
  document.body.appendChild(scrim);
  const first = scrim.querySelector('button:not([data-close]), [tabindex]');
  if (first) first.focus();
  if (onMount) onMount(scrim);
  return scrim;
}
function closeSheet() {
  const s = document.getElementById('sheet');
  if (s) s.remove();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Daily schedule: day 1 is the launch date; legends and the rest interleave.
const LAUNCH = new Date(2026, 9, 29);
function dayNumber(d = new Date()) {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((a - LAUNCH) / 86400000) + 1;
}
function dailyOrder(index, shuffle) {
  const legends = index.filter((r) => r.legend);
  const rest = index.filter((r) => !r.legend);
  const L = [legends[0], ...shuffle(legends.slice(1), 'daily-legends')];
  const R = shuffle(rest, 'daily-rest');
  const out = [];
  let li = 0, ri = 0;
  while (out.length < index.length) {
    if (out.length % 3 === 0 && li < L.length) out.push(L[li++]);
    else if (ri < R.length) out.push(R[ri++]);
    else out.push(L[li++]);
  }
  return out;
}

Object.assign(exports, { esc, fmtDate, toast, openSheet, closeSheet, copyText, dayNumber, dailyOrder, $, $$, pct, avg3, LAUNCH });
});
__def("ui/views.js", function (exports) {
// Screens other than the live game.
const { createGame, ordinal } = __req("engine/game.js");
const { gradeDefense, gradeOffense } = __req("engine/evaluate.js");
const { esc, pct, fmtDate } = __req("ui/util.js");
const { GRADE_EMOJI, GRADE_LETTER, GRADE_WORD, TACTIC_LABEL } = __req("ui/play.js");
const { load, managerStyle, starCount, totalStars } = __req("ui/store.js");
const { PASS, member, priceText } = __req("ui/pass.js");
const { teamColors } = __req("ui/teams.js");

const ROUND_NAME = { worldseries: 'World Series', lcs: 'League Championship', divisionseries: 'Division Series', wildcard: 'Wild Card', playoff: 'Tiebreaker' };
// a forgiving, famous first game for someone who has never played
const FIRST_GAME = 'LAN202110060';

// Playlists are grouped by the situation going into the 9th, never by how the
// game ended, so they don't give anything away.
const COLLECTIONS = [
  { key: 'legends', name: 'Legends', desc: 'The most famous ninth innings ever played', test: (r) => r.legend },
  { key: 'decider', name: 'Winner-take-all', desc: 'Game 7s, one-game playoffs and deciders', test: (r) => r.stakes === 'Winner-take-all' },
  { key: 'elim', name: 'Facing elimination', desc: 'Lose and the season is over', test: (r) => /facing elimination/.test(r.stakes || '') },
  { key: 'tied', name: 'Tied after eight', desc: 'All even going to the ninth', test: (r) => r.margin === 0 },
  { key: 'one', name: 'One-run games', desc: 'One swing changes everything', test: (r) => r.margin === 1 },
  { key: 'rally', name: 'Down two or more', desc: 'Rally time in the ninth', test: (r) => r.margin >= 2 },
  { key: 'ws', name: 'World Series', desc: 'Every Fall Classic that came down to the ninth', test: (r) => r.round === 'worldseries' },
];
function collectionRows(app, key) {
  const c = COLLECTIONS.find((x) => x.key === key);
  return c ? app.index.filter(c.test) : [];
}

function situation(row, side) {
  const s9 = row.s9;
  const mine = s9[side], theirs = s9[1 - side];
  if (mine === theirs) return 'Tied';
  return mine > theirs ? `Up by ${mine - theirs}` : `Down by ${theirs - mine}`;
}
const resultBadge = (id) => {
  const p = load().played[id];
  if (!p || !p.last) return '';
  return p.last.won ? '<span class="badge w">Won</span>' : '<span class="badge l">Lost</span>';
};
function starMarks(n, of = 3) {
  return `<span class="stars" title="${n} of ${of} stars">${Array.from({ length: of }, (_, i) => `<span class="${i < n ? 'on' : ''}">★</span>`).join('')}</span>`;
}
const playedStars = (id) => (load().played[id] ? starMarks(starCount(id)) : '');
const gradeSq = (x) => `<span class="sq ${x}" title="${GRADE_WORD[x]}">${GRADE_LETTER[x]}</span>`;

// ---------------------------------------------------------------- stars
const GPA = { green: 4, yellow: 3, orange: 2, red: 0 };
const gpa = (list) => (list.length ? list.reduce((s, x) => s + GPA[x], 0) / list.length : null);
// [won, no costly calls, out-managed the real manager]
function starsFor(res, calls) {
  const won = res.won ? 1 : 0;
  const clean = res.grades.length > 0 && res.grades.every((x) => x === 'green' || x === 'yellow') ? 1 : 0;
  let beat = 0;
  if (calls) {
    const mine = gpa(res.grades), theirs = gpa(calls.map((c) => c.grade));
    beat = mine !== null && (theirs === null ? mine >= 3.5 : mine >= theirs) ? 1 : 0;
  }
  return [won, clean, beat];
}
function starsHtml(now, sc, side, best) {
  const mgr = (sc.teams[side].mgr || 'the real manager').split(' ').slice(-1)[0];
  const got = (best || now).reduce((a, b) => a + b, 0);
  const items = [['Win the game', now[0]], ['No costly calls (all A or B)', now[1]], [`Out-manage ${mgr}`, now[2]]];
  return `<div id="starrow"><div class="starrow">${items.map(([t, on]) => `<div class="star ${on ? 'on' : ''}"><i>★</i>${esc(t)}</div>`).join('')}</div>
    <p class="muted" style="margin:6px 0 0;font-size:12.5px">Best on this game: ${starMarks(got)} · ${totalStars()} ${totalStars() === 1 ? 'star' : 'stars'} in all</p></div>`;
}

// ---------------------------------------------------------------- home
function homeHtml(app) {
  const st = load();
  const d = app.today;
  const day = app.dayNo;
  const done = st.daily[day];
  const side = d.side;
  const surv = st.survivor;
  const games = st.totals.games;
  const first = games === 0 ? app.index.find((r) => r.id === FIRST_GAME) : null;
  const legends = app.index.filter((r) => r.legend).slice(0, 12);
  const todayCard = `<div class="today"><div class="lights"></div>
      <div class="eyebrow">Today's game · No. ${day} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      <h1>${esc(d.title)}</h1>
      <div class="event">${esc(d.event)} · ${esc(d.teams[0])} at ${esc(d.teams[1])}</div>
      <div class="sit lit-text">${esc(situation(d, side))} · 9th inning</div>
      <p class="intro">${esc(d.intro || '')} You manage the ${esc(d.teams[side])}.</p>
      ${done ? `<p>${done.won ? 'You won' : 'You lost'} today's game ${done.score[0]}-${done.score[1]} · ${done.grades.map((x) => GRADE_EMOJI[x]).join('')}</p>
        <div class="actions"><a class="btn primary" href="#s-${d.id}">Play it again</a></div>`
        : `<div class="actions"><a class="btn primary" href="#daily">Play today's game</a></div>`}
    </div>`;
  const firstCard = first ? `<div class="today"><div class="lights"></div>
      <span class="start">New here? Start with this one</span>
      <h1>${esc(first.title)}</h1>
      <div class="event">${esc(first.event)} · ${esc(first.teams[0])} at ${esc(first.teams[1])}</div>
      <div class="sit lit-text">Tied · 9th inning</div>
      <p class="intro">${esc(first.intro || '')} You manage the ${esc(first.teams[first.side])}: get three outs, then score one run to win. The coach explains every button as you go.</p>
      <div class="actions"><a class="btn primary" href="#s-${first.id}">Play your first game</a><a class="btn" href="#daily">Today's game instead</a></div>
    </div>` : '';
  return `<div class="wrap">
    <div class="hero">
      ${firstCard || todayCard}
      <div class="tiles">
        <a class="card tile" href="#survivor"><span class="eyebrow">Win or Go Home</span><h3>${surv.run ? `Run alive: ${surv.run.wins} won` : 'One loss and you\'re out'}</h3>
          <p>Historic 9th innings back to back. Best run: ${surv.best}.</p></a>
        <a class="card tile" href="${PASS.on && !member() ? '#pass' : '#archive'}"><span class="eyebrow">The archive${PASS.on && !member() ? ' · Season Pass' : ''}</span><h3>500 ninth innings</h3>
          <p>Every postseason game since 1903 that came down to the last frames, plus the tiebreaker playoffs.</p></a>
        <a class="card tile" href="#stats"><span class="eyebrow">Your record</span><h3>${games ? `${st.totals.wins}-${games - st.totals.wins} · ${totalStars()} ★` : 'No games yet'}</h3>
          <p>${games ? `Daily streak ${st.streak.cur} · ${st.totals.calls.green || 0} A calls` : 'Wins, stars, streaks and your managing style show up here.'}</p></a>
      </div>
    </div>
    <div class="section-h"><h2>Playlists</h2><span class="muted">Pick a situation. Three stars to earn on every game.</span></div>
    <div class="collections">${COLLECTIONS.map((c) => {
      const rows = app.index.filter(c.test);
      const stars = rows.reduce((n, r) => n + starCount(r.id), 0);
      const won = rows.filter((r) => st.played[r.id] && st.played[r.id].w > 0).length;
      return `<div class="coll"><b>${esc(c.name)}</b><span>${esc(c.desc)} · ${rows.length} games</span>
        <div class="prog" title="${stars} of ${rows.length * 3} stars"><i style="width:${Math.round((stars / (rows.length * 3)) * 100)}%"></i></div>
        <span>${stars} of ${rows.length * 3} ★ · ${won} won</span>
        <div class="actions"><a class="btn small lit" href="${PASS.on && !member() ? '#pass' : `#rand-${c.key}`}">${PASS.on && !member() ? 'Season Pass' : 'Play one'}</a><a class="btn small ghost" href="#list-${c.key}">See all</a></div></div>`;
    }).join('')}</div>
    ${first ? `<div class="section-h"><h2>Today's game</h2></div><div class="hero" style="margin-top:0;grid-template-columns:minmax(0,1fr)">${todayCard}</div>` : ''}
    <div class="section-h"><h2>Legends</h2><a href="#list-legends" class="muted">See all 80</a></div>
    <div class="legend-grid">${legends.map(cardHtml).join('')}</div>
    ${footer()}
  </div>`;
}

function cardHtml(r) {
  return `<a class="sc-card" href="#s-${r.id}">
    <span class="rankno"><span>No. ${r.rank}</span><span>${playedStars(r.id)} ${resultBadge(r.id)}</span></span>
    <span class="t">${esc(r.title)}</span>
    <span class="e">${esc(r.event)}</span>
    <span class="s">${esc(r.teams[0])} ${r.s9[0]}, ${esc(r.teams[1])} ${r.s9[1]} after 8</span></a>`;
}

function footer() {
  return `<p class="footer-note">Not affiliated with, endorsed by or sponsored by Major League Baseball, its clubs or players. Team and player names identify real games only.
  The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd., Newark, DE 19711.
  Ratings are estimated from each player's real season statistics; pitch types for most pitchers are estimated from their profile.</p>`;
}

// ---------------------------------------------------------------- archive
function archiveHtml(app, f) {
  const decades = [...new Set(app.index.map((r) => Math.floor(r.season / 10) * 10))].sort();
  const rows = filterIndex(app, f);
  const opt = (v, l, cur) => `<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${l}</option>`;
  const coll = COLLECTIONS.find((c) => c.key === f.coll);
  return `<div class="wrap">
    <div class="section-h"><h2>${coll ? esc(coll.name) : 'The archive'}</h2><span class="muted">${rows.length} of 500 · ranked by stakes and ninth-inning drama${coll ? ` · <a href="#rand-${coll.key}">play a random one</a>` : ''}</span></div>
    <div class="card filters">
      <input type="search" id="q" placeholder="Search a team, player, year…" value="${esc(f.q || '')}" aria-label="Search">
      <select id="fcoll" aria-label="Playlist">${opt('', 'All games', f.coll)}${COLLECTIONS.map((c) => opt(c.key, c.name, f.coll)).join('')}</select>
      <select id="fdec" aria-label="Decade">${opt('', 'Any decade', f.dec)}${decades.map((d) => opt(d, `${d}s`, f.dec)).join('')}</select>
      <select id="fround" aria-label="Round">${opt('', 'Any round', f.round)}${Object.entries(ROUND_NAME).map(([k, v]) => opt(k, v, f.round)).join('')}</select>
      <select id="fsit" aria-label="Situation">${opt('', 'Any score', f.sit)}${opt('tied', 'Tied after 8', f.sit)}${opt('1', 'One-run game', f.sit)}${opt('2', 'Two or three runs', f.sit)}</select>
      <select id="fplayed" aria-label="Played">${opt('', 'All', f.played)}${opt('new', 'Not played', f.played)}${opt('won', 'Won', f.played)}${opt('lost', 'Lost', f.played)}</select>
      <label class="chip"><input type="checkbox" id="flegend" ${f.legend ? 'checked' : ''}> Legends only</label>
    </div>
    <div class="list">${rows.slice(0, f.limit || 120).map((r) => `<a class="row" href="#s-${r.id}">
      <span class="rk">${r.rank}</span>
      <span style="min-width:0"><span class="t">${esc(r.title)}</span><br><span class="e">${esc(r.event)} · ${esc(r.teams[0])} ${r.s9[0]}, ${esc(r.teams[1])} ${r.s9[1]} after 8</span></span>
      <span class="rt">${r.legend ? '<span class="badge">Legend</span>' : ''}${playedStars(r.id)}${resultBadge(r.id)}</span></a>`).join('')}</div>
    ${rows.length > (f.limit || 120) ? `<p style="text-align:center"><button class="btn" id="more">Show more</button></p>` : ''}
    ${footer()}</div>`;
}

function filterIndex(app, f) {
  const q = (f.q || '').toLowerCase().trim();
  const st = load();
  const coll = COLLECTIONS.find((c) => c.key === f.coll);
  return app.index.filter((r) => {
    if (coll && !coll.test(r)) return false;
    if (f.legend && !r.legend) return false;
    if (f.dec && Math.floor(r.season / 10) * 10 !== +f.dec) return false;
    if (f.round && r.round !== f.round) return false;
    if (f.sit === 'tied' && r.margin !== 0) return false;
    if (f.sit === '1' && r.margin !== 1) return false;
    if (f.sit === '2' && (r.margin < 2 || r.margin > 3)) return false;
    const p = st.played[r.id];
    if (f.played === 'new' && p) return false;
    if (f.played === 'won' && !(p && p.last && p.last.won)) return false;
    if (f.played === 'lost' && !(p && p.last && !p.last.won)) return false;
    if (q) {
      const hay = `${r.title} ${r.event} ${r.teams.join(' ')} ${r.season} ${r.codes.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------- pregame
function startLabel(sc, st) {
  if (st.idx === 0) return { title: 'The whole 9th', sub: 'Both halves: pitch to their lineup, then manage your at-bats.' };
  const h = sc.history[st.idx];
  const bases = h.r0.filter(Boolean).length;
  const occ = ['first', 'second', 'third'].filter((_, i) => h.r0[i]);
  const where = `${h.h ? 'Bottom' : 'Top'} ${ordinal(h.i)}, ${h.o0} out${bases ? `, ${occ.length === 3 ? 'bases loaded' : 'runner' + (occ.length > 1 ? 's' : '') + ' on ' + occ.join(' and ')}` : ''}, ${sc.teams[0].nick} ${h.s0[0]}, ${sc.teams[1].nick} ${h.s0[1]}`;
  if (st.label === 'Bottom of the 9th') return { title: 'Bottom of the 9th', sub: where };
  return { title: 'The moment', sub: `${where}. The at-bat that swung the game, before either manager's move.` };
}

function pregameHtml(app, sc, choice) {
  const side = choice.side;
  const t = sc.teams;
  const row = app.index.find((r) => r.id === sc.id);
  const colors = teamColors(t[0].code, t[1].code);
  const n = 8;
  const rules = [];
  rules.push(sc.rules.dh ? 'Designated hitter in use' : 'Pitchers hit (no DH)');
  if (sc.rules.three) rules.push('Three-batter minimum for relievers');
  if (!sc.rules.shift) rules.push('No infield shift');
  if (sc.rules.replay) rules.push('Replay review era');
  if (sc.rules.limitPO) rules.push('Two pickoff throws per batter');
  if (sc.rules.autoIBB) rules.push('Intentional walks are automatic');
  const daily = choice.mode === 'daily';
  return `<div class="wrap">
    <div class="pregame">
      <div class="today"><div class="lights"></div>
        <div class="eyebrow">${esc(sc.event)} · ${fmtDate(sc.date)}${sc.park ? ' · ' + esc(sc.park) : ''}</div>
        <h1>${esc(sc.title)}</h1>
        <div class="sit lit-text">${esc(situation(row, side))} going to the 9th</div>
        <p class="intro">${esc(sc.intro)}</p>
        <div class="board" style="margin-top:8px"><div class="board-scroll"><table aria-label="Line score through eight">
          <thead><tr><th></th>${Array.from({ length: n }, (_, i) => `<th class="${i < n - 3 ? 'early' : ''}">${i + 1}</th>`).join('')}<th class="gap"></th><th>R</th><th>H</th><th>E</th></tr></thead>
          <tbody>${[0, 1].map((s) => `<tr><td class="name ${s === side ? 'me' : ''}"><i style="background:${colors[s]}"></i>${esc(t[s].nick)}</td>
            ${sc.line[s].map((v, i) => `<td class="${i < n - 3 ? 'early' : ''}">${v}</td>`).join('')}<td class="gap"></td><td class="rhe">${sc.score9[s]}</td><td class="rhe">${sc.start.he ? sc.start.he[s][0] : ''}</td><td class="rhe">${sc.start.he ? sc.start.he[s][1] : ''}</td></tr>`).join('')}</tbody></table></div></div>
      </div>
      <div class="card panel" style="align-content:start">
        ${choice.challenge ? `<div class="gradebar"><span class="sq yellow">!</span><span><b>A friend challenged you.</b> They managed the ${esc(t[choice.side].nick)} here and ${choice.challenge.won ? 'won' : 'lost'} ${esc(choice.challenge.score)}. Same game, same luck: beat their calls.${choice.challenge.grades.length ? `<span class="why">Their calls: ${choice.challenge.grades.map((x) => gradeSq(x)).join(' ')}</span>` : ''}</span></div>` : ''}
        <div class="eyebrow">${daily ? "Today's game" : `No. ${sc.rank} of 500`}${sc.stakes ? ' · ' + esc(sc.stakes) : ''} · ${esc(sc.series)}</div>
        ${load().played[sc.id] ? `<div class="muted" style="font-size:13px">Your best here: ${starMarks(starCount(sc.id))}</div>` : ''}
        <h3>Pick your dugout</h3>
        <div class="dugout-pick">${[0, 1].map((s) => `<button class="dugout" data-side="${s}" aria-pressed="${s === side}" style="--tc:${colors[s]}" ${choice.challenge && s !== side ? 'disabled' : ''}>
          <b>${esc(t[s].nick)}</b><small>${s === 0 ? 'Visitors' : 'Home'} · ${esc(situation(row, s))}</small><small>Real manager: ${esc(t[s].mgr || 'unknown')}</small></button>`).join('')}</div>
        <h3>Start at</h3>
        <div class="starts">${sc.starts.map((st, i) => {
          const l = startLabel(sc, st);
          if (choice.challenge && choice.start !== i) return '';
          return `<button class="start-opt" data-start="${i}" aria-pressed="${choice.start === i}"><b>${esc(l.title)}</b><br><span class="muted" style="font-size:13px">${esc(l.sub)}</span></button>`;
        }).join('')}</div>
        <div class="eyebrow">Rules for ${sc.rules.season}</div>
        <div class="chips">${rules.map((r) => `<span class="chip" style="cursor:default">${esc(r)}</span>`).join('')}</div>
        <div class="actions"><button class="btn primary" data-go>Play ball</button><a class="btn" href="#archive">Back to the archive</a></div>
        <p class="muted" style="font-size:13px;margin:0">You call the pitches and signs; the computer manages the ${esc(t[1 - side].nick)} and makes the real manager's moves when the game reaches the same spot. Earn up to three stars: win, make no costly calls, and out-manage ${esc(t[side].mgr || 'the real manager')}.</p>
      </div>
    </div>${footer()}</div>`;
}

// ---------------------------------------------------------------- result
function shareText(app, sc, res) {
  const t = sc.teams;
  const me = t[res.side].nick;
  const head = res.mode === 'daily' ? `Last Licks · Daily No. ${res.day}` : res.mode === 'survivor' ? `Last Licks · Win or Go Home` : `Last Licks · No. ${sc.rank}`;
  const greens = res.grades.filter((x) => x === 'green').length;
  return `${head}\n${sc.title} (${sc.event})\n${me}: ${res.won ? 'WON' : 'LOST'} ${res.score[res.side]}-${res.score[1 - res.side]}\n${res.grades.map((x) => GRADE_EMOJI[x]).join('') || '(no calls)'}\n${greens} of ${res.grades.length} calls the best · started at ${pct(res.startWp || 0)} to win`;
}

function resultHtml(app, sc, res, extra) {
  const t = sc.teams;
  const me = res.side;
  const realWin = sc.final[1] > sc.final[0] ? 1 : 0;
  const key = sc.history.reduce((best, h, i) => (Math.abs(h.dwe) > Math.abs(sc.history[best].dwe) ? i : best), 0);
  const changed = res.won && realWin !== me;
  const verdict = changed ? 'You changed history.' : res.won ? 'You matched history.' : realWin === me ? 'History says your team should have won this one.' : 'The ending held.';
  const counts = { green: 0, yellow: 0, orange: 0, red: 0 };
  res.grades.forEach((x) => { counts[x]++; });
  const colors = teamColors(t[0].code, t[1].code);
  const callRows = res.gradeList.map((x) => `<div class="opt"><div><div class="nm">${gradeSq(x.grade)} ${esc(x.mine)}</div>
    <div class="meta">${x.half ? 'Bottom' : 'Top'} ${ordinal(x.inning)} · ${x.grade === 'green' ? 'the best call' : `best was ${esc(x.best)} (+${(x.delta * 100).toFixed(1)} pts)`}</div>
    ${x.why ? `<div class="why">Why: ${esc(x.why)}</div>` : ''}</div>
    <span class="num muted">${pct(x.mineWp)}</span></div>`).join('') || '<p class="muted">No calls this time.</p>';
  const surv = res.mode === 'survivor' ? extra.survivor : null;
  return `<div class="wrap">
    <div class="result">
      <div style="display:grid;gap:14px;align-content:start;min-width:0">
        <div class="banner"><div class="eyebrow">${esc(sc.event)} · ${esc(sc.title)}</div>
          <h1 class="${res.won ? 'won' : ''}">${res.won ? 'You won' : 'You lost'} ${res.score[me]}-${res.score[1 - me]}</h1>
          <p style="margin:10px 0 0">${esc(verdict)} In ${sc.rules.season}, the ${esc(t[realWin].nick)} won ${Math.max(...sc.final)}-${Math.min(...sc.final)}${sc.innings > 9 ? ` in ${sc.innings}` : ''}. ${esc(sc.history[key].t)}</p>
          ${surv ? `<p style="margin:10px 0 0;font-weight:700">${esc(surv)}</p>` : ''}
          ${starsHtml(extra.stars || [0, 0, 0], sc, me)}
          <div class="gridsq">${res.grades.map(gradeSq).join('')}</div>
          <div class="actions">${extra.next ? `<button class="btn primary" data-next>${esc(extra.next)}</button>` : ''}
            <button class="btn" data-again>Play it again</button><button class="btn" data-swap>Manage the ${esc(t[1 - me].nick)}</button><a class="btn" href="#archive">Archive</a></div>
        </div>
        <div class="card panel" style="--mine:${colors[me]}"><h3>Win chance, pitch by pitch</h3>${wpChart(res.wp, colors[me])}</div>
        <div class="card panel"><h3><span>Your calls</span><span class="aside">${counts.green} A · ${counts.yellow} B · ${counts.orange} C · ${counts.red} F</span></h3>${callRows}</div>
        ${pitchCallsHtml(res)}
      </div>
      <div style="display:grid;gap:14px;align-content:start;min-width:0">
        ${extra.challenge ? challengeHtml(sc, res, extra.challenge) : ''}
        <div class="card panel"><h3>Share</h3><div class="share-text" id="share">${esc(shareText(app, sc, res))}</div>
          <div class="actions"><button class="btn primary" data-sharecard>Share</button><button class="btn" data-challenge>Challenge a friend</button><button class="btn ghost" data-copy>Copy text</button></div>
          <p class="muted" style="font-size:12.5px;margin:0">A challenge link gives your friend this exact game with the same luck, so the better manager wins.</p></div>
        <div class="card panel"><h3>You vs. the real manager</h3><div id="realcalls"><p class="muted">Grading ${esc(t[me].mgr || 'the real manager')}'s calls…</p></div></div>
        <div class="card panel"><h3>Film room: what really happened</h3>${filmRoom(sc)}</div>
      </div>
    </div>${footer()}</div>`;
}

const GPA_LETTERS = { green: 4, yellow: 3, orange: 2, red: 0 };
function pitchCallsHtml(res) {
  const pg = res.pitchGrades || [];
  if (!pg.length) return '';
  const c = { green: 0, yellow: 0, orange: 0, red: 0 };
  pg.forEach((x) => { c[x]++; });
  const iq = pg.reduce((s, x) => s + GPA_LETTERS[x], 0) / pg.length;
  return `<div class="card panel"><h3><span>Pitch calls</span><span class="aside">${pg.length} graded · ${c.green} A · ${c.yellow} B · ${c.orange} C · ${c.red} F</span></h3>
    <div class="versus" style="grid-template-columns:auto 1fr;text-align:left;gap:16px"><div><b class="num">${iq.toFixed(1)}</b><span>Pitch IQ</span></div>
    <p class="muted" style="margin:0;font-size:13px">Every pitch you called or sign you gave, graded against the best one for that count and hitter. 4.0 is perfect.</p></div>
    <div class="gridsq">${pg.map(gradeSq).join('')}</div></div>`;
}
function challengeHtml(sc, res, ch) {
  const mine = gpa(res.grades), theirs = gpa(ch.grades);
  const fmt = (v) => (v === null ? '—' : v.toFixed(1));
  const winner = res.won && !ch.won ? 'you' : ch.won && !res.won ? 'them' : (mine ?? 0) >= (theirs ?? 0) ? 'you' : 'them';
  return `<div class="card panel"><h3>You vs. your friend</h3>
    <div class="versus"><div><b class="num">${res.won ? 'W' : 'L'} ${res.score[res.side]}-${res.score[1 - res.side]}</b><span>You · calls ${fmt(mine)}</span></div><span class="vs">vs</span><div><b class="num">${ch.won ? 'W' : 'L'} ${esc(ch.score)}</b><span>Them · calls ${fmt(theirs)}</span></div></div>
    <p style="margin:0">${winner === 'you' ? 'You out-managed them.' : 'They got you this time.'} Same game, same luck: <button class="linkbtn" data-challenge>send one back</button>.</p></div>`;
}

function filmRoom(sc) {
  const key = sc.history.reduce((best, h, i) => (Math.abs(h.dwe) > Math.abs(sc.history[best].dwe) ? i : best), 0);
  let lastHalf = null;
  const rows = sc.history.map((h, i) => {
    let head = '';
    const hk = `${h.i}${h.h}`;
    if (hk !== lastHalf) { lastHalf = hk; head = `<div class="eyebrow" style="margin-top:6px">${h.h ? 'Bottom' : 'Top'} of the ${ordinal(h.i)}</div>`; }
    const subs = (h.subs || []).filter((s) => s.k !== 'pos').map((s) => {
      const team = sc.teams[s.t].nick;
      const verb = { pitch: 'bring in', ph: 'send up pinch hitter', pr: 'send in pinch runner', def: 'put in' }[s.k] || 'put in';
      return `<div class="sub">${esc(team)} ${verb} ${esc(nameOf(sc, s.in))}${s.out && s.k !== 'pitch' ? ` for ${esc(nameOf(sc, s.out))}` : ''}</div>`;
    }).join('');
    const homeWp = h.we + h.dwe;
    return `${head}<div class="r ${i === key ? 'key' : ''}"><span class="muted">${h.o0} out</span><span>${subs}${esc(h.t)}</span><span class="wpx">${pct(homeWp)}</span></div>`;
  }).join('');
  return `<div class="film">${rows}</div><p class="muted" style="font-size:12px;margin:6px 0 0">Right column: the home team's chance to win after each play, from a league-average model.</p>`;
}
const NAME_CACHE = new Map();
function nameOf(sc, pid) {
  const shard = NAME_CACHE.get('shard');
  if (shard) {
    const p = shard.players[`${pid}:${sc.rules.season}`];
    if (p) return p.n;
  }
  return pid;
}
function setNameShard(shard) { NAME_CACHE.set('shard', shard); }

const CH = { W: 560, H: 190, L: 40, R: 12, T: 12, B: 26 };
function wpChart(series, color) {
  if (!series || series.length < 2) return '<p class="muted">Not enough plays to chart.</p>';
  const { W, H, L, R, T, B } = CH;
  const n = series.length;
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - v) * (H - T - B);
  let d = '';
  series.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.wp).toFixed(1)} `; });
  const area = `${d} L${x(n - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z`;
  const grid = [0, 0.5, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line-2)" ${v === 0.5 ? 'stroke-dasharray="4 4"' : ''}/>
    <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--font-body)">${v * 100}%</text>`).join('');
  const last = series[n - 1];
  const pts = series.map((p, i) => `<rect x="${x(i) - (W - L - R) / (2 * (n - 1))}" y="${T}" width="${(W - L - R) / (n - 1)}" height="${H - T - B}" fill="transparent" data-i="${i}"/>`).join('');
  return `<div class="wpchart" style="position:relative">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Win chance from ${pct(series[0].wp)} to ${pct(last.wp)}">
      <defs><linearGradient id="wpfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#wpfill)"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 4px ${color})"/>
      <circle cx="${x(n - 1)}" cy="${y(last.wp)}" r="4" fill="${color}" stroke="#000" stroke-width="2"/>
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>
      <circle class="xd" r="4" fill="${color}" stroke="#000" stroke-width="2" visibility="hidden"/>
      <text x="${L}" y="${H - 8}" font-size="11" fill="var(--muted)" font-family="var(--font-body)">${esc(series[0].label)}</text>
      <text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--font-body)">${esc(last.label)}</text>
      <g class="hits">${pts}</g>
    </svg>
    <div class="tip" hidden style="position:absolute;pointer-events:none;font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap"></div>
    <details style="margin-top:6px"><summary class="muted" style="font-size:12.5px">Show the numbers</summary>
      <table style="font-size:12.5px;border-collapse:collapse;margin-top:6px">${series.map((p) => `<tr><td style="padding:2px 10px 2px 0">${esc(p.label)}</td><td class="num">${pct(p.wp)}</td></tr>`).join('')}</table></details>
  </div>`;
}

function wireChart(root, series) {
  const wrap = root.querySelector('.wpchart');
  if (!wrap || !series || series.length < 2) return;
  const svg = wrap.querySelector('svg');
  const tip = wrap.querySelector('.tip');
  const xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd');
  const { W, H, L, R, T, B } = CH;
  const n = series.length;
  svg.addEventListener('mousemove', (e) => {
    const r = e.target.closest('[data-i]');
    if (!r) return;
    const i = +r.dataset.i;
    const px = L + (i / (n - 1)) * (W - L - R), py = T + (1 - series[i].wp) * (H - T - B);
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', px); xd.setAttribute('cy', py); xd.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${series[i].label}: ${pct(series[i].wp)}`;
    const box = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(box.width - 150, Math.max(0, (px / W) * box.width - 50))}px`;
    tip.style.top = `${(py / H) * box.height - 34}px`;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); });
}

// Grade the real manager's calls for one dugout by replaying history.
function realManagerCalls(sc, shard, side) {
  const out = [];
  const hist = sc.history;
  for (let k = 0; k < hist.length; k++) {
    const h = hist[k];
    const prev = hist[k - 1];
    const paStart = k === 0 || prev.pa || prev.i !== h.i || prev.h !== h.h || prev.lp !== h.lp;
    if (!paStart) continue;
    try {
      const g = createGame(sc, shard, { userSide: -1, seed: 'real', startIdx: k });
      if (g.over) break;
      const subs = h.subs || [];
      g.applySubs(subs.filter((s) => s.t !== side));
      if (h.h !== side) {
        const pitch = subs.find((s) => s.t === side && s.k === 'pitch');
        const basePid = g.fld().pitcher;
        const pid = pitch && g.fld().pen.includes(pitch.in) ? pitch.in : basePid;
        const ibb = /^(IW|I)(\.|$|\+)/.test(h.ev);
        const r = gradeDefense(g, { pid, ibb, align: { inf: 'normal', of: 'normal' } }, { pid: basePid }, { fixedAlign: true });
        const pl = g.P(pid);
        const desc = `${pid !== basePid ? `Brought in ${pl.l}` : `Stayed with ${pl.l}`}${ibb ? ', walked him' : ''}`;
        const best = g.P(r.best.pid);
        out.push({ grade: r.grade, delta: r.delta, desc, best: `${r.best.pid !== basePid ? `bring in ${best.l}` : `stay with ${best.l}`}${r.best.ibb ? ', walk him' : ''}`, inning: h.i, half: h.h, batter: g.P(g.batter().pid).l });
      } else {
        const baseBatter = g.batter().pid;
        const ph = subs.find((s) => s.t === side && s.k === 'ph');
        const batter = ph && g.bat().bench.includes(ph.in) ? ph.in : baseBatter;
        const runners = g.bases.map((r) => (r ? r.pid : null));
        for (const s of subs.filter((x) => x.t === side && x.k === 'pr')) {
          const i = runners.indexOf(s.out);
          if (i >= 0) runners[i] = s.in;
        }
        let tactic = 'swing';
        const ev = h.ev;
        if (/^(SB|CS)2/.test(ev) || /SB2/.test(ev)) tactic = 'steal2';
        else if (/^(SB|CS)3/.test(ev)) tactic = 'steal3';
        else if (/^(SB|CS)H/.test(ev)) tactic = 'steal4';
        else if (/\/(SH|BG|BP|BL)/.test(ev)) tactic = h.r0[2] && h.s1[side] > h.s0[side] ? 'squeeze' : 'sac';
        const r = gradeOffense(g, { batter, runners, tactic }, { batter: baseBatter, runners: g.bases.map((x) => (x ? x.pid : null)) });
        const bl = g.P(batter).l;
        const prDesc = runners.map((pid, i) => (pid && g.bases[i] && pid !== g.bases[i].pid ? `, ${g.P(pid).l} ran` : '')).join('');
        const desc = `${batter !== baseBatter ? `${bl} pinch-hit` : `${bl} hit`}${prDesc}, ${TACTIC_LABEL[tactic]}`;
        const bestDesc = `${r.best.batter !== baseBatter ? `${g.P(r.best.batter).l} pinch-hits` : `${g.P(r.best.batter).l} hits`}, ${TACTIC_LABEL[r.best.tactic]}`;
        out.push({ grade: r.grade, delta: r.delta, desc, best: bestDesc, inning: h.i, half: h.h, batter: bl });
      }
    } catch (e) { console.error(e); }
  }
  return out;
}

function realCallsHtml(sc, side, calls, res) {
  const mgr = sc.teams[side].mgr || 'The real manager';
  const mine = res ? gpa(res.grades) : null, theirs = gpa(calls.map((c) => c.grade));
  const fmt = (v) => (v === null ? '—' : v.toFixed(1));
  const versus = `<div class="versus"><div><b class="num">${fmt(mine)}</b><span>You</span></div><span class="vs">vs</span><div><b class="num">${fmt(theirs)}</b><span>${esc(mgr)}</span></div></div>
    <p class="muted" style="font-size:12px;margin:0;text-align:center">Grade average: A = 4, B = 3, C = 2, F = 0.</p>`;
  if (!calls.length) return `${versus}<p class="muted">No decisions of theirs to grade in this game.</p>`;
  const greens = calls.filter((c) => c.grade === 'green').length;
  return `${versus}<p style="margin:0">${esc(mgr)}: ${calls.map((c) => GRADE_EMOJI[c.grade]).join('')} · ${greens} of ${calls.length} best</p>
    ${calls.map((c) => `<div class="opt"><div><div class="nm">${gradeSq(c.grade)} ${esc(c.desc)}</div>
      <div class="meta">${c.half ? 'Bottom' : 'Top'} ${ordinal(c.inning)}${c.grade === 'green' ? '' : ` · best was ${esc(c.best)} (+${(c.delta * 100).toFixed(1)} pts)`}</div></div></div>`).join('')}
    <p class="muted" style="font-size:12px;margin:0">Their fielders' positioning isn't in the record, so these grades cover pitchers, walks, pinch hitters, runners, bunts and steals.</p>`;
}

// ---------------------------------------------------------------- stats
function statsHtml(app) {
  const st = load();
  const t = st.totals;
  const style = managerStyle(t);
  const calls = t.calls;
  const total = (calls.green || 0) + (calls.yellow || 0) + (calls.orange || 0) + (calls.red || 0);
  const recent = Object.entries(st.played).filter(([, p]) => p.last).sort((a, b) => b[1].last.when - a[1].last.when).slice(0, 12);
  return `<div class="wrap">
    <div class="section-h"><h2>Your record</h2><span class="muted">Saved in this browser</span></div>
    <div class="stat-grid">
      <div class="card stat"><b class="num">${t.wins}-${t.games - t.wins}</b><span>Won-lost</span></div>
      <div class="card stat"><b class="num">${totalStars()}</b><span>Stars of ${app.index.length * 3}</span></div>
      <div class="card stat"><b class="num">${t.games ? pct(t.wins / t.games) : '—'}</b><span>Win rate</span></div>
      <div class="card stat"><b class="num">${st.streak.cur}</b><span>Daily streak (best ${st.streak.best})</span></div>
      <div class="card stat"><b class="num">${st.survivor.best}</b><span>Best Win or Go Home run</span></div>
      <div class="card stat"><b class="num">${total ? pct((calls.green || 0) / total) : '—'}</b><span>Calls that graded A</span></div>
    </div>
    <div class="section-h"><h2>Who you manage like</h2></div>
    <div class="card panel">${style ? `<h3>${esc(style.name)}</h3><p style="margin:0">${esc(style.why)}</p>` : '<p class="muted" style="margin:0">Manage three games and your style shows up here.</p>'}
      <div class="gridsq">${['green', 'yellow', 'orange', 'red'].map((k) => `<span class="chip" style="cursor:default">${gradeSq(k)} ${calls[k] || 0}</span>`).join('')}</div></div>
    <div class="section-h"><h2>Playlists</h2></div>
    <div class="collections">${COLLECTIONS.map((c) => {
      const rows = app.index.filter(c.test);
      const stars = rows.reduce((n, r) => n + starCount(r.id), 0);
      return `<a class="coll" href="#list-${c.key}"><b>${esc(c.name)}</b><div class="prog"><i style="width:${Math.round((stars / (rows.length * 3)) * 100)}%"></i></div><span>${stars} of ${rows.length * 3} ★</span></a>`;
    }).join('')}</div>
    <div class="section-h"><h2>Keep your record safe</h2><span class="muted">Your record lives in this browser only</span></div>
    <div class="card panel">
      <p style="margin:0">Safari can clear a site's saved data after a week away, and a new phone or iPad starts empty. Copy your save code somewhere safe; paste it back to restore your wins, stars, streak${PASS.on ? ' and Season Pass' : ''}. Adding Last Licks to your Home Screen also keeps it from being cleared.</p>
      <div class="actions"><button class="btn" id="savecode">Copy my save code</button></div>
      <div class="group"><label class="eyebrow" for="restore">Restore from a save code</label>
        <textarea id="restore" rows="2" placeholder="LL1.…" style="width:100%;background:var(--surface-2);border:1px solid var(--line-2);border-radius:8px;color:var(--ink);padding:9px 10px;font:13px/1.4 var(--font-type)"></textarea>
        <div class="actions"><button class="btn" id="restorebtn">Restore</button></div></div>
    </div>
    ${PASS.on ? `<div class="section-h"><h2>Season Pass</h2></div><div class="card panel">${member() ? `<p style="margin:0">Your Season Pass is active on this device${load().pass.email ? ` (${esc(load().pass.email)})` : ''}. Every game in the archive is open.</p><div class="actions"><button class="btn ghost" id="forgetpass">Remove it from this device</button></div>` : `<p style="margin:0">All 500 games, replays and playlists for ${priceText()}.</p><div class="actions"><a class="btn primary" href="#pass">See the Season Pass</a></div>`}</div>` : ''}
    <div class="section-h"><h2>Recent games</h2></div>
    <div class="list">${recent.map(([id, p]) => {
      const r = app.index.find((x) => x.id === id);
      if (!r) return '';
      return `<a class="row" href="#s-${id}"><span class="rk">${r.rank}</span><span style="min-width:0"><span class="t">${esc(r.title)}</span><br><span class="e">${esc(r.event)} · managed the ${esc(r.teams[p.last.side])} · ${p.last.score[0]}-${p.last.score[1]}</span></span><span class="rt">${playedStars(id)}${p.last.won ? '<span class="badge w">Won</span>' : '<span class="badge l">Lost</span>'}</span></a>`;
    }).join('') || '<p class="muted">Nothing yet.</p>'}</div>
    ${footer()}</div>`;
}

// ---------------------------------------------------------------- season pass
function passHtml(app) {
  const has = member();
  const ready = !!PASS.checkout;
  const perks = [
    ['All 500 ninth innings', 'Every World Series, LCS, Division Series and Wild Card game since 1903 that came down to the last frames.'],
    ['Replay anything', 'Any game, from either dugout, from the whole 9th, the bottom of the 9th or the moment that swung it.'],
    ['Playlists and Legends', 'Winner-take-all, facing elimination, tied after eight, one-run games and the 80 most famous ninths.'],
    ['Every star to chase', `${app.index.length * 3} stars across the archive.`],
  ];
  return `<div class="wrap"><div class="pregame">
    <div class="today"><div class="lights"></div>
      <div class="eyebrow">Season Pass</div><h1>Every ninth inning, any time</h1>
      <div class="sit lit-text">${esc(priceText())}</div>
      <p class="intro">Free players get today's game and Win or Go Home. The Season Pass opens the whole archive.${PASS.per ? ' Cancel anytime.' : ''}</p>
      ${has ? '<p><b>Your Season Pass is active.</b> <a href="#archive">Go to the archive</a></p>'
        : ready ? `<div class="actions"><a class="btn primary" href="${esc(PASS.checkout)}" target="_blank" rel="noopener">Get the Season Pass</a></div>
          <p class="muted" style="font-size:13px">Payment is handled by Lemon Squeezy. Your license key arrives by email; enter it below on any device.</p>`
          : '<p class="muted">Season Passes open soon.</p>'}
    </div>
    <div class="card panel" style="align-content:start">
      ${perks.map(([h, p]) => `<div><b>${esc(h)}</b><div class="muted" style="font-size:13.5px">${esc(p)}</div></div>`).join('')}
      ${has ? '' : `<div class="group"><label class="eyebrow" for="passkey">Have a license key?</label>
        <input id="passkey" autocomplete="off" spellcheck="false" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" style="width:100%;background:var(--surface-2);border:1px solid var(--line-2);border-radius:8px;color:var(--ink);padding:10px 11px;font:14px var(--font-type)">
        <div class="actions"><button class="btn" id="redeem">Unlock</button></div><p class="muted" id="passmsg" style="margin:0;font-size:13px"></p></div>`}
    </div></div>${footer()}</div>`;
}

// ---------------------------------------------------------------- how to play
function howtoHtml() {
  return `<div class="howto">
    <p>You're the manager for the 9th inning of a real postseason game: the real lineups, benches and bullpens, rated from that season's statistics. Win the game.</p>
    <ul>
      <li><b>When your team is in the field</b>, call the pitch: pick a pitch type, tap a spot in the zone (catcher's view, with the batter standing on the side he hits from) and throw it, or let the catcher call it. <b>Manager</b> has the bullpen, intentional walks, mound visits, fielder positioning and pickoffs.</li>
      <li><b>When your team is batting</b>, pick an approach (swing away, take, sit on the fastball, protect the plate). Tap the zone to have your hitter <b>look for a pitch</b> in that spot: if it comes there he hits it harder, if not he's fooled. Read the pitcher: the shading shows where he likes to throw in this count. With two strikes, don't guess. <b>Signs</b> has bunts, squeezes, steals and the hit-and-run, with each runner's odds; <b>Bench</b> has pinch hitters and runners. Lightning bolts show speed.</li>
      <li><b>You call every pitch.</b> Want it quicker? Turn on <b>Auto-play</b> in the menu: routine pitches play themselves, and the game stops you for the first pitch of each at-bat, every pitch with three balls or two strikes, and anything after runners move. ⏭ sims the rest of an at-bat.</li>
      <li><b>Close plays at the plate</b> come to you: send the runner or hold him.</li>
      <li><b>Every manager call is graded</b> against the best option at that moment, using an exact win-probability model: <b class="grade-word green">A</b> best or as good, <b class="grade-word yellow">B</b> close, <b class="grade-word orange">C</b> costly, <b class="grade-word red">F</b> a big miss. After each one you see why.</li>
      <li><b>Every pitch call and sign is graded too</b>, on a finer scale: the letter sits on the pitch mark, costly ones come with the better choice, and your Pitch IQ shows at the end. A good call can still get hit; the grade is about the decision.</li>
      <li><b>The coach</b> explains things in plain English for your first games. Turn it on or off in the menu.</li>
      <li><b>The other dugout</b> is run by the computer. When your game reaches the same spot as the real one, it makes the real manager's moves.</li>
      <li><b>Stars:</b> every game has three. Win, make no costly calls, and grade out better than the real manager.</li>
      <li><b>Challenge a friend</b> from the results: they get the same game with the same luck, so the better manager wins.</li>
    </ul>
    <p><b>Keyboard:</b> <span class="kbd">1</span>-<span class="kbd">6</span> pitch type, arrow keys move the target, <span class="kbd">Enter</span> throws or takes the next pitch, <span class="kbd">C</span> catcher's call. A tap or <span class="kbd">Enter</span> skips an animation.</p>
    <p><b>Modes:</b> Today's game is the same for everyone each day. Win or Go Home strings 9th innings together until you lose; if every call in a loss graded A or B, you get one free pass per run. Playlists group the archive by situation.</p>
    <p><b>On a phone or iPad,</b> add Last Licks to your Home Screen (Share, then Add to Home Screen): it opens full screen like an app, and your record is safer there. The Record page has a save code to back it up.</p>
  </div>`;
}

Object.assign(exports, { collectionRows, situation, starsFor, starsHtml, homeHtml, footer, archiveHtml, filterIndex, startLabel, pregameHtml, shareText, resultHtml, setNameShard, wireChart, realManagerCalls, realCallsHtml, statsHtml, passHtml, howtoHtml, FIRST_GAME, COLLECTIONS });
});
__req("ui/main.js");
})();
