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

export const ALIGN_DEFAULT = { inf: 'normal', of: 'normal', shift: false };

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
export function profile(category, ctx) {
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
export function conversions(category, prof, ctx) {
  const align = ctx.align || ALIGN_DEFAULT;
  const d = (ctx.def && ctx.def[prof.field]) || 50;
  const res = [];
  const push = (p, cat, error = false) => { if (p > 1e-9) res.push({ p, category: cat, error }); };
  const infield = prof.field <= 6;
  const isOF = prof.field >= 7;
  let toHit = 0, toOut = 0, toSingle = 0;
  if (category === 'OUT') {
    if (prof.bb === 'G' && infield && prof.field !== 1 && prof.field !== 2) {
      if (align.inf === 'in') toHit += 0.22;
      else if (align.inf === 'corners' && (prof.field === 3 || prof.field === 5)) toHit += 0.12;
      else if (align.inf === 'dp') toHit += 0.03;
      else if (align.inf === 'lines') toHit += 0.03;
      if (align.shift && ctx.batSide === 'L' && (prof.field === 5 || prof.field === 6) && prof.pull === 'oppo') toHit += 0.4;
      if (d < 50) toHit += 0.007 * (50 - d);
    }
    if (prof.bb === 'F' && isOF) {
      if (align.of === 'deep' && prof.depth === 'shallow') toHit += 0.12;
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
      if (align.of === 'shallow' && category === 'B1') toOut += 0.18;
      if (align.of === 'deep' && category !== 'B1') { toOut += 0.22; toSingle += 0.3; }
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
export function sendSafeProb(kind, runner, ctx, prof, outs) {
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
export function autoSend(pSafe, outs, kind, ctx) {
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
export function advance(category, prof, ctx, outs, bases, batter, policy) {
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
export function fairBallBranches(category, ctx, outs, bases, batter, policy) {
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
