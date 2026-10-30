// Game state machine for one scenario: the 9th inning and any extras.
//
// The UI (or the AI) drives it with:
//   g.pitch({ call, sign, defense })   one pitch
//   g.ibb(), g.pickoff(base), g.visit()
//   g.changePitcher(pid, opts), g.pinchHit(pid), g.pinchRun(base, pid),
//   g.defSub(slot, pid, pos), g.movePos(slot, pos), g.setAlign(side, align), g.warm(pid)
//   g.answer(choice)                    resolve a pending decision (send/hold)
// Everything that happens is appended to g.log.

import { makeRng } from './rng.js';
import { fatigue } from './model.js';
import { buildMatchup, catcherCall, deliver, resolveAtPlate, cellV, cellH, PITCH_TYPES, inZone } from './pitch.js';
import { profile, conversions, advance, autoSend, ALIGN_DEFAULT } from './bip.js';
import { stealBranches, buntBranches, hitAndRunBranches, ibbBranches, forcedAdvance, stealProb } from './tactics.js';
import { describeFair, joinNames, fielderName, fieldName } from './text.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const POS_ABBR = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH', 11: 'PH', 12: 'PR' };
export { POS_ABBR };

const GENERIC = { n: 'Unknown player', l: 'Player', b: 'R', t: 'R', h: [0.16, 0.08, 0.008, 0.02, 0.15, 0.04, 0.005], spd: 45, stl: 0.65, bnt: 45, d: {}, arm: 50 };

export function createGame(sc, shard, opts = {}) {
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
    const key = `${b.pid}|${ft.pitcher}|${Math.round(this.pitcherTired(ft) * 20)}|${this.tto(ft, b.pid)}`;
    if (this._mkey !== key) {
      this._mkey = key;
      this._m = buildMatchup(this.P(b.pid), this.pitcherObj(), { lg: this.lg, tired: this.pitcherTired(ft), tto: this.tto(ft, b.pid) });
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
    const res = resolveAtPlate(M, cell, ti, countKey, stealing ? 'take' : (sign.approach || 'normal'), this.seq, this.rng);
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
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
