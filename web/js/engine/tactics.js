// Manager tactics as weighted branches. Live play samples a branch; the grader
// sums over them. A branch is the state right after the tactic resolves:
// { p, outs (added), bases: [r1,r2,r3], scored: [...], pa: result | null,
//   sameBatter: bool, count: {b,s} (when sameBatter), note }

import { fairBallBranches, autoSend } from './bip.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const BATTER = { batter: true };

// batter to first, forced runners move up
export function forcedAdvance([r1, r2, r3], B = BATTER) {
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
export function stealProb(runner, base, ctx) {
  const lgp = (ctx.lg && ctx.lg.sbpct) || 0.68;
  const spd = runner.spd || 50;
  const skill = runner.stl || lgp;
  let p = 0.45 * lgp + 0.55 * skill + 0.006 * (spd - 50) - 0.005 * ((ctx.catcherArm || 50) - 50);
  if (base === 2 && ctx.pitcherThrows === 'L') p -= 0.07;
  if (base === 3) p += 0.04;
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
export function stealBranches(bases, which, ctx, count, zoneP) {
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
    const ps = clamp(stealProb(r2, 3, ctx) + 0.04, 0.05, 0.97);
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
export function buntBranches(kind, bases, outs, batter, ctx, count) {
  const [r1, r2, r3] = bases;
  const skill = batter.bnt || 45;
  const spd = batter.spd || 50;
  const corners = !!(ctx.align && ctx.align.inf === 'corners');
  let contact = clamp(0.8 + 0.006 * (skill - 50), 0.45, 0.95);
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
    const score = clamp(0.88 + 0.003 * (skill - 50), 0.6, 0.97);
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
  const sac = allUp(bases, null);
  add(fair * succ / tot, 1, sac.bases, outs < 2 ? sac.scored : [], 'sacrifice bunt, the runners move up');
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
export function hitAndRunBranches(M, bases, outs, batter, count, ctx) {
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
export function ibbBranches(bases) {
  const w = forcedAdvance(bases);
  return [{ p: 1, outs: 0, bases: w.bases, scored: w.scored, pa: 'IBB', sameBatter: false, note: 'intentional walk' }];
}
