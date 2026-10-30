// Plain-English help for new managers: what each control does, what the
// inning needs, which runs matter, and (after a call is graded) why the best
// call was best. Nothing here tells the player the answer before they choose.
import { paTarget, fatigue } from '../engine/model.js';
import { stealProb } from '../engine/tactics.js';
import { ordinal } from '../engine/game.js';
import { settings, setSetting, load } from './store.js';

// ---------------------------------------------------------------- control help
export const SIGN_HELP = {
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
export const DEF_HELP = {
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

export const PITCH_HELP = {
  FF: 'Hard and straight', SI: 'Bores in, gets grounders', FC: 'Late cut, breaks bats',
  SL: 'Sharp, late break', CU: 'Big, slow drop', KC: 'Hard, deep drop',
  CH: 'Looks like a fastball, arrives late', FS: 'Dives under the bat', SC: 'Breaks the other way',
  KN: 'Floats and flutters',
};

// ---------------------------------------------------------------- the inning
const WHERE = ['on first', 'on second', 'on third'];

// Who carries the tying and go-ahead runs for the team at bat.
export function keyRuns(g) {
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

export function runTags(g) {
  const k = keyRuns(g);
  const tags = [];
  if (k.tying) tags.push(`Tying run ${k.tying.where}`);
  if (k.ahead) tags.push(`${k.ahead.label} ${k.ahead.where}`);
  return tags;
}

// One sentence: what this half-inning needs from the player's team.
export function mission(g, me) {
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

export function countTalk(c) {
  const k = `${c.b}-${c.s}`;
  if (k === '0-0') return 'First pitch';
  if (k === '3-2') return 'Full count';
  if (['2-0', '3-0', '3-1', '2-1'].includes(k)) return "Hitter's count";
  if (['0-2', '1-2', '0-1'].includes(k)) return "Pitcher's count";
  return 'Even count';
}

// ---------------------------------------------------------------- projections
export function reach(g, batter, pitcher, tired = 0) {
  const d = paTarget(batter, pitcher, { lg: g.lg, tired });
  return { obp: d.BB + d.HBP + d.B1 + d.B2 + d.B3 + d.HR, xb: d.B2 + d.B3 + d.HR };
}
const pctw = (x) => `${Math.round(x * 100)}%`;
function pitcherTired(g, team, pid) {
  if (pid === team.pitcher) return g.pitcherTired(team);
  return fatigue(g.P(pid), 0, team.energy[pid] ?? 1, false);
}
export function stealOdds(g, base) {
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

export function whyDefense(g, chosen, best) {
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

export function whyOffense(g, chosen, best) {
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
export function coachOn() {
  const c = settings().coach;
  if (c === 'on') return true;
  if (c === 'off') return false;
  return load().totals.games < 3;
}
export function setCoach(on) { setSetting('coach', on ? 'on' : 'off'); }
function seen() { const s = settings(); return s.seen || (s.seen = {}); }
export function markSeen(key) { seen()[key] = 1; setSetting('seen', seen()); }

// The first unseen tip that fits the moment. Tips explain the tradeoff, never the answer.
export function tipFor(g, me) {
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

export const halfName = (g) => `${g.half ? 'Bottom' : 'Top'} of the ${ordinal(g.inning)}`;
