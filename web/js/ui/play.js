// Game screen: you manage one dugout; the AI manages the other.
// One screen on phones and tablets: score strip, field, the at-bat panel and a
// dock of big buttons; everything else slides up in a sheet. Every pitch gets
// a beat (the ball lands on the zone and the call is stamped) and a grade.
// The player calls every pitch by default; with auto-play on, routine pitches
// play themselves and the game stops for the at-bat's first pitch, the big
// counts and new situations.
import { createGame, POS_ABBR, ordinal } from '../engine/game.js';
import { aiPrePA, aiSign, aiDefensePitch } from '../engine/ai.js';
import { winProb, gradeDefense, gradeOffense, forSide, pitchOutcomes, pitchValue, pitchGradeOf } from '../engine/evaluate.js';
import { paTarget, battingSide, fatigue } from '../engine/model.js';
import { zoneMap, PITCH_TYPES, cellIndex, cellH, cellV, inZone, inLook } from '../engine/pitch.js';
import { renderField, pitchFlight } from './field.js';
import { batterSilhouette, speedLabel, speedBadge } from './art.js';
import { teamColors, teamAbbr } from './teams.js';
import { pop, crack, crowdReact, charge, sting, setCrowd, stopCrowd, unlock, soundOn, toggleSound } from './sound.js';
import { SIGN_HELP, DEF_HELP, PITCH_HELP, keyRuns, runTags, mission, countTalk, stealOdds, whyDefense, whyOffense, coachOn, setCoach, tipFor, markSeen } from './coach.js';
import { esc, pct, avg3, toast, openSheet, closeSheet } from './util.js';
import { settings, setSetting } from './store.js';

export const TACTIC_LABEL = {
  swing: 'swing away', take: 'take a pitch', sac: 'sacrifice bunt', squeeze: 'suicide squeeze',
  safety: 'safety squeeze', drag: 'drag bunt', steal2: 'steal second', steal3: 'steal third',
  steal4: 'steal home', double: 'double steal', hitrun: 'hit-and-run',
};
const INF_LABEL = { normal: 'normal', in: 'drawn in', dp: 'double-play depth', corners: 'corners in', lines: 'guarding the lines' };
const OF_LABEL = { normal: 'normal', deep: 'deep (no doubles)', shallow: 'shallow' };
export const GRADE_WORD = { green: 'Best call', yellow: 'Close', orange: 'Costly', red: 'Big miss' };
export const GRADE_LETTER = { green: 'A', yellow: 'B', orange: 'C', red: 'F' };
export const GRADE_EMOJI = { green: '🟩', yellow: '🟨', orange: '🟧', red: '🟥' };
const RESULT_CLASS = { ball: 'ball', hbp: 'ball', called: 'strike', swinging: 'strike', foul: 'foul', inplay: 'inplay' };
const APPROACH = { normal: 'Swing away', take: 'Take', takeUntilStrike: 'Take until a strike', sitFB: 'Sit fastball', protect: 'Protect' };
const ONESHOT = { sac: 'Sacrifice', drag: 'Bunt for a hit', squeeze: 'Suicide squeeze', safety: 'Safety squeeze', steal2: 'Steal 2nd', steal3: 'Steal 3rd', steal4: 'Steal home', double: 'Double steal', hitrun: 'Hit and run', runhit: 'Run and hit' };
const LOOKS = [null];
for (let v = -1; v <= 1; v++) for (let h = -1; h <= 1; h++) if (h || v) LOOKS.push(cellIndex(h, v));
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function energyLabel(e) {
  if (e >= 0.85) return ['fresh', 'Fresh'];
  if (e >= 0.6) return ['ok', 'Rested'];
  if (e >= 0.35) return ['tired', 'Tired'];
  return ['gassed', 'Gassed'];
}

// Where a cell is, in the hitter's terms.
export function spotWords(cell) {
  const h = cellH(cell), v = cellV(cell);
  const vert = { 2: 'high', 1: 'up', 0: '', '-1': 'down', '-2': 'in the dirt' }[v];
  const horiz = { 2: 'way inside', 1: 'in', 0: '', '-1': 'away', '-2': 'way outside' }[h];
  if (!vert && !horiz) return 'down the middle';
  return [vert, horiz].filter(Boolean).join(' and ');
}

// Movement of each pitch type as seen by the catcher: [arm-side or glove-side x, drop]
const BREAK = { FF: [0, -3, 330], SI: [-8, 9, 340], FC: [6, 2, 340], SL: [14, 6, 380], CU: [6, 20, 440], KC: [7, 18, 420], CH: [-8, 12, 420], FS: [0, 18, 400], SC: [-12, 10, 420], KN: [0, 0, 480] };

export function mountGame(root, ctx) {
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
    if (el) el.innerHTML = statusText();
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
      const types = M.types.map((t, i) => `<button class="ptype" data-ti="${i}" aria-pressed="${C.ui.ti === i}"><span class="kbd k">${i + 1}</span><b>${esc((PITCH_TYPES[t.key] || {}).short || t.key)}</b><small>${Math.round(t.q)} grade · ${t.use}%${coach && PITCH_HELP[t.key] ? ` · ${PITCH_HELP[t.key]}` : ''}</small></button>`).join('');
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
  C.destroy = () => {
    document.removeEventListener('keydown', onKey);
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
