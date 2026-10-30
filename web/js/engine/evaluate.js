// Win probability for a live game, and grades for manager calls.

import { transitions, halfTable, runDist, homeWP, extraTied, avgFresh, MAXR, maskOf } from './wp.js';
import { paTarget, fatigue } from './model.js';
import { paDist, buildMatchup } from './pitch.js';
import { fairBallBranches, autoSend, ALIGN_DEFAULT } from './bip.js';
import { stealBranches, buntBranches, hitAndRunBranches, ibbBranches, forcedAdvance } from './tactics.js';

const TABLES = new Map();
const FAIR = ['HR', 'B3', 'B2', 'B1', 'OUT'];

// rough run value of a pitcher's rates (lower is better)
export function pitcherValue(pl, tired = 0) {
  const r = pl.p ? pl.p.r : [0.15, 0.09, 0.008, 0.025, 0.16, 0.045, 0.005];
  const [k, bb, hbp, hr, b1, b2, b3] = r;
  return (0.7 * (bb + hbp) + 0.9 * b1 + 1.25 * b2 + 1.6 * b3 + 2.0 * hr - 0.1 * k) * (1 + 0.35 * tired);
}
export function hitterValue(pl) {
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
export function allHands(g) {
  return /Winner-take-all|elimination/.test(g.sc.stakes || '') || g.sc.round === 'playoff';
}
export function relieverPool(g, team) {
  if (allHands(g)) return team.pen;
  const pool = team.pen.filter((pid) => { const p = g.P(pid).p; return !p || p.role !== 'SP'; });
  return pool.length ? pool : team.pen;
}

// who a team will most likely pitch next half
export function projectedPitcher(g, team, exclude) {
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
export function winProb(g) {
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

export const forSide = (wpHome, side) => (side === 1 ? wpHome : 1 - wpHome);

// ---------------------------------------------------------------- defense options
// opt: { pid (pitcher), ibb: bool, align: {inf, of, shift} }
export function evalDefense(g, opt) {
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

export function evalOffense(g, opt) {
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
export function tacticOptions(g) {
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

export function defenseOptions(g, opts = {}) {
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

export function offenseOptions(g, opts = {}) {
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
export function gradeOf(delta) {
  const d = delta * 100;
  if (d <= 0.75) return 'green';
  if (d <= 2.25) return 'yellow';
  if (d <= 5) return 'orange';
  return 'red';
}

// Score every defensive call and grade the chosen one (from the fielding side's view).
// chosen: { pid, ibb, align }; base: { pid } the pitcher before any change this PA
export function gradeDefense(g, chosen, base = {}, opts = {}) {
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
export function gradeOffense(g, chosen, base = {}) {
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

export function clearCaches() { TABLES.clear(); MATCHUPS.clear(); }
