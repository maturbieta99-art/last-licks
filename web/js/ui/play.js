// Game screen: you manage one dugout; the AI manages the other.
import { createGame, POS_ABBR, ordinal } from '../engine/game.js';
import { aiPrePA, aiSign, aiDefensePitch } from '../engine/ai.js';
import { winProb, gradeDefense, gradeOffense, forSide } from '../engine/evaluate.js';
import { batterGrades, paTarget, battingSide, fatigue } from '../engine/model.js';
import { zoneMap, PITCH_TYPES, cellIndex, cellH, cellV, inZone } from '../engine/pitch.js';
import { renderField } from './field.js';
import { esc, pct, avg3, toast, openSheet, closeSheet } from './util.js';
import { settings } from './store.js';

export const TACTIC_LABEL = {
  swing: 'swing away', take: 'take until a strike', sac: 'sacrifice bunt', squeeze: 'suicide squeeze',
  safety: 'safety squeeze', drag: 'drag bunt', steal2: 'steal second', steal3: 'steal third',
  steal4: 'steal home', double: 'double steal', hitrun: 'hit-and-run',
};
const INF_LABEL = { normal: 'normal', in: 'drawn in', dp: 'double-play depth', corners: 'corners in', lines: 'guarding the lines' };
const OF_LABEL = { normal: 'normal', deep: 'deep (no doubles)', shallow: 'shallow' };
const GRADE_WORD = { green: 'Best call', yellow: 'Close', orange: 'Costly', red: 'Big miss' };
export const GRADE_EMOJI = { green: '🟩', yellow: '🟨', orange: '🟧', red: '🟥' };

export function energyLabel(e) {
  if (e >= 0.85) return ['fresh', 'Fresh'];
  if (e >= 0.6) return ['ok', 'Rested'];
  if (e >= 0.35) return ['tired', 'Tired'];
  return ['gassed', 'Gassed'];
}

export function mountGame(root, ctx) {
  const g = createGame(ctx.sc, ctx.shard, { userSide: ctx.userSide, startIdx: ctx.startIdx, seed: ctx.seed });
  const C = {
    g, userSide: ctx.userSide,
    ui: { ti: 0, cell: cellIndex(0, 0), approach: 'normal', oneShot: null, pitchout: false, slideStep: false, tab: 'lineup', scouting: true },
    paKey: null, aiPlan: null, base: null, graded: false,
    grades: [], wp: [], lastGrade: null, lastPlay: null, lastBall: null, moves: {},
    startWp: null, done: false,
  };
  const me = () => C.userSide;
  const myTeam = () => g.teams[me()];
  const userBatting = () => g.half === me();
  const wpUser = () => forSide(winProb(g), me());
  const bump = (k) => { C.moves[k] = (C.moves[k] || 0) + 1; };

  // ------------------------------------------------------------ flow
  function advance() {
    let guard = 0;
    while (!g.over && guard++ < 30) {
      const key = g.paNo + ':' + g.inning + ':' + g.half;
      if (key === C.paKey) break;
      C.paKey = key;
      const fSide = 1 - g.half, bSide = g.half;
      if (fSide !== me()) aiPrePA(g, fSide);
      if (g.over) break;
      if (g.paNo + ':' + g.inning + ':' + g.half !== key) continue;
      C.aiPlan = bSide !== me() ? aiPrePA(g, bSide) : null;
      if (g.over) break;
      if (g.paNo + ':' + g.inning + ':' + g.half !== key) continue;
      C.graded = false;
      C.base = userBatting() ? { batter: g.batter().pid, runners: g.bases.map((r) => (r ? r.pid : null)) } : { pid: g.fld().pitcher };
      C.ui.oneShot = null;
      if (C.ui.approach !== 'takeUntilStrike') C.ui.approach = 'normal';
      C.ui.pitchout = false;
      C.ui.slideStep = false;
      try {
        const w = wpUser();
        C.wp.push({ label: `${g.half ? 'B' : 'T'}${g.inning} ${g.outs} out`, wp: w });
        if (C.startWp === null) C.startWp = w;
      } catch (e) { console.error(e); }
    }
    if (g.over) return finish();
    render();
    if (g.pending && g.pending.kind === 'needPitcher' && g.pending.side === me()) bullpenSheet(true);
  }

  function afterAction(beforeLen) {
    const evs = g.log.slice(beforeLen);
    const plays = evs.filter((e) => e.kind === 'play' || e.kind === 'walkoff');
    if (plays.length) C.lastPlay = plays[plays.length - 1].text;
    const pitchEv = evs.filter((e) => e.kind === 'pitch').pop();
    if (pitchEv) C.lastPitch = pitchEv.pitch;
    const ball = evs.filter((e) => e.kind === 'play' && e.prof).pop();
    if (ball) C.lastBall = ball;
    if (g.pending && g.pending.resolve) return render(), sendPrompt();
    advance();
  }

  function finish() {
    if (C.done) return;
    C.done = true;
    const result = {
      id: ctx.sc.id, won: g.winner === me(), score: [...g.score], side: me(), grades: C.grades.map((x) => x.grade),
      gradeList: C.grades, wp: C.wp.concat([{ label: 'Final', wp: g.winner === me() ? 1 : 0 }]),
      startWp: C.startWp, moves: C.moves, mode: ctx.mode, day: ctx.day, log: g.log, innings: g.inning,
      line: g.line, hits: g.hits, errors: g.errors, teams: g.teams.map((t) => t.nick),
    };
    ctx.onFinish(result);
  }

  // ------------------------------------------------------------ grading
  function addGrade(kind, r, mine, best) {
    const entry = { kind, grade: r.grade, delta: r.delta, mine, best, inning: g.inning, half: g.half, mineWp: r.mine, bestWp: r.best.wp };
    C.grades.push(entry);
    C.lastGrade = entry;
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
      addGrade('def', r, describeDef(chosen), describeDef(r.best));
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
  function gradeOff() {
    try {
      const chosen = { batter: g.batter().pid, runners: g.bases.map((r) => (r ? r.pid : null)), tactic: signTactic() };
      const r = gradeOffense(g, chosen, C.base);
      addGrade('off', r, describeOff(chosen), describeOff(r.best));
    } catch (e) { console.error(e); }
    C.graded = true;
  }

  // ------------------------------------------------------------ actions
  function userPitch(auto) {
    if (g.pending || g.over) return;
    if (!C.graded) gradeDef(false);
    const before = g.log.length;
    const sign = aiSign(g, C.aiPlan);
    const call = auto ? null : { ti: C.ui.ti, target: C.ui.cell };
    g.pitch({ call, sign, defense: { pitchout: C.ui.pitchout, slideStep: C.ui.slideStep } });
    C.ui.pitchout = false;
    afterAction(before);
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
    return sign;
  }
  function userBat() {
    if (g.pending || g.over) return;
    if (!C.graded) gradeOff();
    else if (C.ui.oneShot && C.ui.oneShot !== 'runhit') {
      try {
        const chosen = { batter: g.batter().pid, runners: g.bases.map((r) => (r ? r.pid : null)), tactic: signTactic() };
        const r = gradeOffense(g, chosen, C.base);
        addGrade('off', r, describeOff(chosen), describeOff(r.best));
      } catch (e) { console.error(e); }
    }
    const o = C.ui.oneShot;
    if (o) bump(o === 'sac' || o === 'drag' ? 'bunt' : o === 'squeeze' || o === 'safety' ? 'squeeze' : o === 'hitrun' || o === 'runhit' ? 'hitrun' : 'steal');
    const before = g.log.length;
    g.pitch({ call: null, sign: buildSign(), defense: aiDefensePitch(g) });
    C.ui.oneShot = null;
    if (C.ui.approach === 'takeUntilStrike' && g.count.s > 0) C.ui.approach = 'normal';
    afterAction(before);
  }
  function simAtBat() {
    const key = C.paKey;
    let n = 0;
    while (!g.over && !g.pending && C.paKey === key && n++ < 20) {
      if (userBatting()) userBat(); else userPitch(true);
    }
  }
  function sendPrompt() {
    const p = g.pending;
    openSheet('Your call', `<p class="prompt-big">${esc(p.text)}</p>
      <p class="muted">Your third-base coach thinks he's safe about <b class="num">${pct(p.pSafe)}</b> of the time if you send him.</p>
      <div class="actions"><button class="btn primary" data-send="1">Send him</button><button class="btn" data-send="0">Hold him</button></div>`,
    (el) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-send]');
        if (!b) return;
        const before = g.log.length;
        closeSheet();
        g.answer(b.dataset.send === '1');
        afterAction(before);
      });
    }, { locked: true });
  }

  // ------------------------------------------------------------ sheets
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
        : can.ok ? '<p class="muted">A reliever who warms up first is sharper than one rushed in cold. Between innings everyone gets his warm-up pitches.</p>'
          : `<p class="muted">${esc(can.reason)}</p>`;
    openSheet(forced ? 'Bring in a pitcher' : 'Bullpen', note + rows, (el) => {
      el.addEventListener('click', (e) => {
        const wb = e.target.closest('[data-warm]');
        if (wb) { g.warm(wb.dataset.warm); bullpenSheet(forced); render(); return; }
        const bb = e.target.closest('[data-bring]');
        if (bb) {
          const r = g.changePitcher(bb.dataset.bring, { side: me(), force: forced });
          if (!r.ok) { toast(r.reason); return; }
          bump('pitch');
          closeSheet();
          render();
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
        proj = ` · vs ${esc(pit.l)}: ${avg3(d.BB + d.HBP + d.B1 + d.B2 + d.B3 + d.HR)} OBP, ${avg3(d.B1 + 2 * d.B2 + 3 * d.B3 + 4 * d.HR)} SLG/PA`;
      }
      const posList = Object.keys(pl.d || {}).filter((p) => +p >= 2).map((p) => POS_ABBR[p]).join(' ');
      const runBtns = batting ? g.bases.map((r, i) => (r ? `<button class="btn small" data-pr="${i + 1}" data-pid="${pid}">Run for ${esc(r.name)}</button>` : '')).join('') : '';
      return `<div class="opt"><div><div class="nm">${esc(pl.n)} <span class="muted">bats ${pl.b} · ${posList || 'bench'}</span></div>
        <div class="meta">${bl ? `${avg3(bl[0])}/${avg3(bl[1])}/${avg3(bl[2])}, ${bl[3]} HR, ${bl[5]} SB` : ''}${proj}</div>
        <div class="meta">Speed ${pl.spd}</div></div>
        <div class="actions">${batting && !g.paStarted ? `<button class="btn small primary" data-ph="${pid}">Pinch-hit</button>` : ''}${runBtns}</div></div>`;
    }).join('') || '<p class="muted">Nobody left on the bench.</p>';
    const note = batting ? (g.paStarted ? '<p class="muted">Pinch hitters come in before the first pitch of an at-bat. You can still send in a pinch runner.</p>'
      : `<p class="muted">${esc(g.P(g.batter().pid).n)} is due up. Anyone you take out can't come back.</p>`)
      : '<p class="muted">Use the Defense tab to make defensive changes.</p>';
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
          bump('pr'); closeSheet(); render();
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

  // ------------------------------------------------------------ render pieces
  function scoreboard() {
    const n = Math.max(9, g.inning);
    const cols = Array.from({ length: n }, (_, i) => i + 1);
    const row = (side) => {
      const t = g.teams[side];
      const cells = cols.map((i) => {
        const v = g.line[side][i - 1];
        const cur = i === g.inning && side === g.half && !g.over;
        const future = v === undefined || (i > g.inning) || (i === g.inning && side > g.half && !g.over);
        return `<td class="${cur ? 'cur' : ''} ${future && v === undefined ? 'empty' : ''}">${v === undefined ? '' : v}</td>`;
      }).join('');
      return `<tr><td class="name ${side === me() ? 'me' : ''}"><i style="background:${side === 0 ? 'var(--away)' : 'var(--home)'}"></i>${esc(t.nick)}</td>${cells}
        <td class="rhe">${g.score[side]}</td><td class="rhe">${g.hits[side]}</td><td class="rhe">${g.errors[side]}</td></tr>`;
    };
    const w = (() => { try { return wpUser(); } catch { return null; } })();
    const prev = C.wp.length > 1 ? C.wp[C.wp.length - 2].wp : null;
    const delta = w !== null && C.wp.length ? w - C.wp[C.wp.length - 1].wp : 0;
    const shownDelta = Math.abs(delta) >= 0.005 ? delta : (prev !== null && C.wp.length ? C.wp[C.wp.length - 1].wp - prev : 0);
    const bulbs = (n, on, cls) => Array.from({ length: n }, (_, i) => `<span class="bulb ${i < on ? 'on ' + cls : ''}"></span>`).join('');
    return `<div class="board">
      <div class="board-scroll"><table aria-label="Line score">
        <thead><tr><th></th>${cols.map((i) => `<th>${i}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr></thead>
        <tbody>${row(0)}${row(1)}</tbody></table></div>
      <div class="status">
        <span class="inning-tag">${g.half ? 'Bottom' : 'Top'} ${ordinal(g.inning)}</span>
        <div class="bso" aria-label="Count ${g.count.b} balls ${g.count.s} strikes, ${g.outs} out">
          <div>B ${bulbs(3, g.count.b, 'b')}</div><div>S ${bulbs(2, g.count.s, 's')}</div><div>O ${bulbs(2, g.outs, 'o')}</div></div>
        <div class="wp"><small>${esc(myTeam().nick)} win chance</small><b class="num">${w === null ? '—' : pct(w)}</b>
          ${shownDelta ? `<span class="delta ${shownDelta > 0 ? 'up' : 'down'} num">${shownDelta > 0 ? '+' : ''}${(shownDelta * 100).toFixed(0)}</span>` : ''}</div>
      </div></div>`;
  }

  function matchupCard() {
    const b = g.P(g.batter().pid), p = g.pitcherObj();
    const gr = batterGrades(b, g.lg);
    const line = g.lines[g.batter().pid];
    const today = line ? `${line[2]}-for-${line[1]} today` : 'first time up today';
    const bl = b.bl;
    const ft = g.fld();
    const ps = ft.pst[ft.pitcher] || { pitches: 0, bf: 0 };
    const tired = g.pitcherTired(ft);
    const pl = p.p ? p.p.pl : null;
    const ars = (p.p && p.p.ars) || [];
    const side = battingSide(b.b, p.t);
    return `<div class="card matchup">
      <div class="who"><div class="eyebrow">At bat · ${esc(g.teams[g.half].nick)}</div><div class="nm">${esc(b.n)}</div>
        <div class="ln">Bats ${b.b === 'B' ? `both (hitting ${side === 'L' ? 'left' : 'right'})` : b.b === 'L' ? 'left' : 'right'} · ${bl ? `${avg3(bl[0])}/${avg3(bl[1])}/${avg3(bl[2])}, ${bl[3]} HR` : 'no season line'} · ${today}</div>
        <div class="grades"><div><b>${gr.contact}</b><span>Contact</span></div><div><b>${gr.power}</b><span>Power</span></div><div><b>${gr.eye}</b><span>Eye</span></div><div><b>${gr.speed}</b><span>Speed</span></div></div></div>
      <div class="vs">VS</div>
      <div class="who"><div class="eyebrow">Pitching · ${esc(ft.nick)}</div><div class="nm">${esc(p.n)}</div>
        <div class="ln">${p.t === 'L' ? 'Left' : 'Right'}-hander · ${pl ? `${pl[2].toFixed(2)} ERA, ${pl[5]} K, ${pl[3]} SV` : ''}</div>
        <div class="ln num">${Math.round(ps.pitches)} pitches today${ps.est ? ' (est.)' : ''} · ${ars.map((a) => (PITCH_TYPES[a[0]] || {}).short || a[0]).join(', ')}</div>
        <div class="meter" title="Fatigue"><i style="width:${Math.round((1 - tired) * 100)}%;background:${tired > 0.6 ? 'var(--g-red)' : tired > 0.3 ? 'var(--g-orange)' : 'var(--g-green)'}"></i></div>
        <div class="ln">${tired > 0.6 ? 'Running on fumes' : tired > 0.3 ? 'Tiring' : 'Strong'}</div></div></div>`;
  }

  function zoneHtml() {
    const b = g.P(g.batter().pid), p = g.pitcherObj();
    const side = battingSide(b.b, p.t);
    const zm = zoneMap(b);
    const last = C.lastPitch && C.lastPitchPA === g.paNo ? C.lastPitch : null;
    let cells = '';
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const v = 2 - r;
        const h = side === 'R' ? 2 - c : c - 2;
        const idx = cellIndex(h, v);
        const z = zm[idx];
        const heat = C.ui.scouting && inZone(idx) ? (z > 1.06 ? `background: color-mix(in srgb, var(--hot) ${Math.min(55, Math.round((z - 1) * 260))}%, var(--surface))` : z < 0.94 ? `background: color-mix(in srgb, var(--cold) ${Math.min(50, Math.round((1 - z) * 260))}%, var(--surface))` : '') : '';
        const label = `${v > 0 ? (v === 2 ? 'high, out of the zone' : 'up') : v < 0 ? (v === -2 ? 'in the dirt' : 'down') : 'middle'} and ${h > 0 ? (h === 2 ? 'inside off the plate' : 'in') : h < 0 ? (h === -2 ? 'off the outside corner' : 'away') : 'over the plate'}`;
        const dot = last && last.cell === idx ? `<span class="dot" style="background:${last.result === 'ball' ? 'var(--muted)' : last.result === 'inplay' ? 'var(--ink)' : 'var(--accent)'}"></span>` : '';
        cells += `<button class="zcell ${inZone(idx) ? 'in' : ''}" style="${heat}" data-cell="${idx}" aria-pressed="${C.ui.cell === idx}" aria-label="${label}">${dot}</button>`;
      }
    }
    return `<div class="zone" role="group" aria-label="Pitch location, catcher's view">${cells}<span class="sz"></span></div>`;
  }

  function controls() {
    const ft = g.fld();
    if (g.over) return '';
    if (!userBatting()) {
      const M = g.matchup();
      const types = M.types.map((t, i) => `<button class="ptype" data-ti="${i}" aria-pressed="${C.ui.ti === i}"><b>${esc((PITCH_TYPES[t.key] || {}).short || t.key)}</b><small>${Math.round(t.q)} grade · thrown ${t.use}%</small></button>`).join('');
      const b = g.P(g.batter().pid);
      const pre = !g.paStarted;
      const al = ft.align;
      const chip = (grp, val, label, dis = false) => `<button class="chip" data-align="${grp}:${val}" aria-pressed="${(grp === 'inf' ? al.inf : grp === 'of' ? al.of : String(!!al.shift)) === val}" ${dis ? 'disabled' : ''}>${label}</button>`;
      const pick = g.bases.map((r, i) => (r ? `<button class="btn small" data-pickoff="${i + 1}">Throw to ${['1st', '2nd', '3rd'][i]}</button>` : '')).join('');
      return `<div class="card panel">
        <h3><span>Call the pitch</span><span class="muted" style="font:600 12px var(--font-body);text-transform:none">${esc(b.l)} ${b.b === 'L' ? 'bats left' : b.b === 'B' ? 'switch-hits' : 'bats right'} · catcher's view</span></h3>
        <div class="pitch-types">${types}</div>
        <div class="zone-wrap">${zoneHtml()}
          <div class="zone-legend">
            <label><input type="checkbox" data-scout ${C.ui.scouting ? 'checked' : ''}> Scouting report</label>
            <span><span class="sq" style="background:var(--hot)"></span> hot zone · <span class="sq" style="background:var(--cold)"></span> cold zone</span>
            <span>Estimated from his season numbers. Pitches away from the middle get weaker contact; misses over the plate get hit hard. Throw the same pitch too often and he'll time it.</span>
          </div></div>
        <div class="actions">
          <button class="btn primary" data-act="pitch">Throw it <span class="kbd">Enter</span></button>
          <button class="btn" data-act="catcher">Catcher's call <span class="kbd">C</span></button>
          <button class="btn" data-act="sim">Sim at-bat</button>
          ${g.bases.some(Boolean) ? `<button class="chip" data-toggle="pitchout" aria-pressed="${C.ui.pitchout}">Pitchout</button><button class="chip" data-toggle="slideStep" aria-pressed="${C.ui.slideStep}">Slide step</button>` : ''}
        </div>
        ${pick ? `<div class="actions">${pick}</div>` : ''}
      </div>
      <div class="card panel">
        <h3><span>Manager</span><span class="muted" style="font:600 12px var(--font-body);text-transform:none">${pre ? 'Before the first pitch' : `${g.count.b}-${g.count.s} count`}</span></h3>
        <div class="eyebrow">Infield</div>
        <div class="chips">${chip('inf', 'normal', 'Normal')}${chip('inf', 'in', 'Drawn in')}${chip('inf', 'dp', 'Double-play depth')}${chip('inf', 'corners', 'Corners in')}${chip('inf', 'lines', 'Guard the lines')}</div>
        <div class="eyebrow">Outfield</div>
        <div class="chips">${chip('of', 'normal', 'Normal')}${chip('of', 'deep', 'No doubles')}${chip('of', 'shallow', 'Shallow')}${g.rules.shift ? chip('shift', 'true', 'Shift', b.b === 'R') : ''}</div>
        <div class="actions">
          <button class="btn" data-act="ibb">Intentional walk</button>
          <button class="btn" data-act="visit">Mound visit</button>
          <button class="btn" data-act="bullpen">Bullpen</button>
          <button class="btn" data-act="defense">Defense</button>
        </div></div>`;
    }
    // batting
    const b = g.bases;
    const s = g.count.s;
    const ap = (val, label, key) => `<button class="chip" data-approach="${val}" aria-pressed="${C.ui.approach === val}">${label}${key ? ` <span class="kbd">${key}</span>` : ''}</button>`;
    const os = (val, label, ok) => `<button class="chip" data-oneshot="${val}" aria-pressed="${C.ui.oneShot === val}" ${ok ? '' : 'disabled'}>${label}</button>`;
    return `<div class="card panel">
      <h3><span>Give the sign</span><span class="muted" style="font:600 12px var(--font-body);text-transform:none">${g.count.b}-${g.count.s} count</span></h3>
      <div class="signs">
        <div class="group"><div class="eyebrow">Approach</div><div class="chips">
          ${ap('normal', 'Swing away')}${ap('take', 'Take this pitch')}${ap('takeUntilStrike', 'Take until a strike')}${ap('sitFB', 'Sit on the fastball')}${ap('protect', 'Protect the plate')}</div></div>
        <div class="group"><div class="eyebrow">Bunt</div><div class="chips">
          ${os('sac', 'Sacrifice', g.outs < 2 && (b[0] || b[1]))}${os('drag', 'Bunt for a hit', true)}${os('squeeze', 'Suicide squeeze', g.outs < 2 && b[2])}${os('safety', 'Safety squeeze', g.outs < 2 && b[2])}</div></div>
        <div class="group"><div class="eyebrow">Run</div><div class="chips">
          ${os('steal2', 'Steal 2nd', b[0] && !b[1])}${os('steal3', 'Steal 3rd', b[1] && !b[2])}${os('steal4', 'Steal home', b[2])}${os('double', 'Double steal', b[0] && b[1] && !b[2])}${os('hitrun', 'Hit and run', b[0] && !b[1] && g.outs < 2 && s < 2)}${os('runhit', 'Run and hit', b[0] && !b[1])}</div></div>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="bat">Next pitch <span class="kbd">Enter</span></button>
        <button class="btn" data-act="sim">Sim at-bat</button>
        <button class="btn" data-act="bench">Bench: pinch-hit or run</button>
        <button class="btn" data-act="bullpen">Bullpen</button>
      </div></div>`;
  }

  function callbar() {
    const x = C.lastGrade;
    if (!x) return `<div class="callbar"><span class="sq" style="background:var(--line)"></span><span>Every manager call gets graded against the best option at that moment: <span class="grade-word green">green</span> best, <span class="grade-word yellow">yellow</span> close, <span class="grade-word orange">orange</span> costly, <span class="grade-word red">red</span> a big miss.</span></div>`;
    const tail = x.grade === 'green' ? '' : ` Best was: ${esc(x.best)} (+${(x.delta * 100).toFixed(1)} pts).`;
    return `<div class="callbar"><span class="sq ${x.grade}"></span><span><b class="grade-word ${x.grade}">${GRADE_WORD[x.grade]}.</b> ${esc(x.mine)}.${tail}</span></div>`;
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
          <span class="sub">${pl.b}</span></div>`;
      }).join('');
      if (team.dh) body += `<div class="pl"><span class="pos">P</span><div><div class="nm">${esc(g.P(team.pitcher).n)}</div><div class="sub">pitching</div></div><span class="sub">${g.P(team.pitcher).t}</span></div>`;
    } else if (tab === 'bench') {
      body = t.bench.map((pid) => {
        const pl = g.P(pid);
        return `<div class="pl"><span class="pos">${POS_ABBR[pl.pr] || ''}</span><div><div class="nm">${esc(pl.n)}</div><div class="sub">${pl.bl ? `${avg3(pl.bl[0])}/${avg3(pl.bl[1])}/${avg3(pl.bl[2])}, ${pl.bl[3]} HR, ${pl.bl[5]} SB` : ''} · speed ${pl.spd}</div></div><span class="sub">${pl.b}</span></div>`;
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
    return `<div class="card"><div class="tabs" role="tablist">${tb('lineup', 'Lineup')}${tb('bench', 'Bench')}${tb('pen', 'Bullpen')}${tb('opp', esc(g.teams[1 - me()].nick))}</div>
      <div class="roster">${body}</div></div>`;
  }

  function logHtml() {
    const evs = g.log.filter((e) => ['play', 'move', 'halfStart', 'history', 'pitch', 'walkoff', 'note', 'decision'].includes(e.kind) && !e.quiet);
    const gradeAt = new Map();
    // interleave grades at the moment they were made
    let gi = 0;
    const out = [];
    for (const e of evs.slice(-80)) {
      let cls = 'ev';
      if (e.kind === 'play' || e.kind === 'walkoff') cls += ' play';
      if (e.kind === 'move') cls += ' move';
      if (e.kind === 'history') cls += ' hist';
      if (e.kind === 'halfStart') cls += ' half';
      const tag = e.kind === 'pitch' ? `${e.count.b}-${e.count.s}` : `${e.half ? 'B' : 'T'}${e.inning}`;
      out.push(`<div class="${cls}"><span class="tag">${tag}</span><span>${esc(e.text)}${e.kind === 'history' ? ' <span class="muted">(real game)</span>' : ''}</span></div>`);
    }
    void gradeAt; void gi;
    return `<div class="card"><div class="tabs"><button aria-selected="true">Play-by-play</button></div><div class="log" id="log">${out.reverse().join('')}</div></div>`;
  }

  function render() {
    const occ = ['first', 'second', 'third'].filter((_, i) => g.bases[i]);
    const sit = `${g.half ? 'Bottom' : 'Top'} of the ${ordinal(g.inning)}, ${g.outs} out, ${occ.length === 3 ? 'bases loaded' : occ.length ? 'runner' + (occ.length > 1 ? 's' : '') + ' on ' + occ.join(' and ') : 'nobody on'}. ${g.P(g.batter().pid).n} is up.`;
    const lp = C.lastPlay ? esc(C.lastPlay) : esc(sit);
    root.innerHTML = `<div class="wrap">
      <div class="section-h" style="margin-top:14px"><div><div class="eyebrow">${esc(ctx.sc.event)} · You manage the ${esc(myTeam().nick)}</div>
        <h2 style="font-size:26px">${esc(ctx.sc.title)}</h2></div>
        <div class="actions"><button class="btn small" data-act="help">How to play</button><button class="btn small" data-act="quit">Leave game</button></div></div>
      ${scoreboard()}
      <div class="game">
        <div style="display:grid;gap:14px;align-content:start;min-width:0">
          <div class="card fieldcard">${renderField(g, C.lastBall)}<div class="lastplay" aria-live="polite">${lp}</div></div>
          ${logHtml()}
        </div>
        <div class="desk">${callbar()}${matchupCard()}${controls()}${rosterTab()}</div>
      </div></div>`;
    if (C.lastPitch) C.lastPitchPA = C.lastPitchPA ?? g.paNo;
  }

  // ------------------------------------------------------------ events
  root.onclick = (e) => {
    const t = e.target.closest('button, input');
    if (!t) return;
    const d = t.dataset;
    if (d.ti !== undefined) { C.ui.ti = +d.ti; return render(); }
    if (d.cell !== undefined) { C.ui.cell = +d.cell; return render(); }
    if (d.scout !== undefined) { C.ui.scouting = t.checked; return render(); }
    if (d.tab) { C.ui.tab = d.tab; return render(); }
    if (d.approach) { C.ui.approach = d.approach; return render(); }
    if (d.oneshot) { C.ui.oneShot = C.ui.oneShot === d.oneshot ? null : d.oneshot; return render(); }
    if (d.toggle) { C.ui[d.toggle] = !C.ui[d.toggle]; return render(); }
    if (d.align) {
      const [grp, val] = d.align.split(':');
      if (grp === 'shift') g.setAlign(me(), { shift: !g.teams[me()].align.shift });
      else g.setAlign(me(), { [grp]: val });
      return render();
    }
    if (d.pickoff) {
      const before = g.log.length;
      const r = g.pickoff(+d.pickoff);
      if (r === 'out') toast('Picked him off!');
      afterAction(before);
      return;
    }
    switch (d.act) {
      case 'pitch': C.lastPitchPA = g.paNo; return userPitch(false);
      case 'catcher': C.lastPitchPA = g.paNo; return userPitch(true);
      case 'bat': C.lastPitchPA = g.paNo; return userBat();
      case 'sim': return simAtBat();
      case 'ibb': {
        if (!C.graded) gradeDef(true);
        bump('ibb');
        const before = g.log.length;
        g.ibb();
        return afterAction(before);
      }
      case 'visit': {
        const r = g.visit();
        if (!r.ok) toast(r.reason); else bump('visit');
        return render();
      }
      case 'bullpen': return bullpenSheet(false);
      case 'bench': return benchSheet();
      case 'defense': return defenseSheet();
      case 'help': return ctx.onHelp();
      case 'quit': return ctx.onQuit();
      default:
    }
  };
  const onKey = (e) => {
    if (document.getElementById('sheet') || C.done) return;
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    const fielding = !userBatting();
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.closest && e.target.closest('button') && e.key === ' ') return;
      e.preventDefault();
      C.lastPitchPA = g.paNo;
      return fielding ? userPitch(false) : userBat();
    }
    if (fielding && (e.key === 'c' || e.key === 'C')) { C.lastPitchPA = g.paNo; return userPitch(true); }
    if (fielding && /^[1-6]$/.test(e.key)) {
      const i = +e.key - 1;
      if (i < g.matchup().types.length) { C.ui.ti = i; render(); }
      return;
    }
    if (fielding && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const b = g.P(g.batter().pid), p = g.pitcherObj();
      const side = battingSide(b.b, p.t);
      let h = cellH(C.ui.cell), v = cellV(C.ui.cell);
      const dir = side === 'R' ? -1 : 1; // screen right is away from a righty
      if (e.key === 'ArrowUp') v = Math.min(2, v + 1);
      if (e.key === 'ArrowDown') v = Math.max(-2, v - 1);
      if (e.key === 'ArrowLeft') h = Math.max(-2, Math.min(2, h - dir));
      if (e.key === 'ArrowRight') h = Math.max(-2, Math.min(2, h + dir));
      C.ui.cell = cellIndex(h, v);
      render();
    }
  };
  document.addEventListener('keydown', onKey);
  C.destroy = () => document.removeEventListener('keydown', onKey);
  advance();
  return C;
}
