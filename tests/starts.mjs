import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { gradeDefense, gradeOffense, winProb } from '../web/js/engine/evaluate.js';
import { playAI } from './simall.mjs';
const index = JSON.parse(readFileSync(new URL('../web/data/index.json', import.meta.url)));
const shards = {};
const shard = (f) => (shards[f] ||= JSON.parse(readFileSync(new URL('../web/data/' + f, import.meta.url))));
let n = 0, err = 0;
for (const row of index) {
  const sh = shard(row.shard), sc = sh.scenarios[row.id];
  for (const st of sc.starts) {
    try {
      const g = createGame(sc, sh, { userSide: -1, seed: 'x', startIdx: st.idx });
      const h = sc.history[st.idx];
      // the replayed state must match the real state before that play
      const bases = g.bases.map((r) => (r ? r.pid : null));
      const ok = g.inning === h.i && g.half === h.h && g.outs === h.o0 && JSON.stringify(g.score) === JSON.stringify(h.s0)
        && bases.every((b, i) => (b ? 1 : 0) === (h.r0[i] ? 1 : 0)) && g.bat().slot === h.lp;
      if (!ok) { err++; if (err < 8) console.log('MISMATCH', row.id, st.label, { inn: [g.inning, h.i], half: [g.half, h.h], outs: [g.outs, h.o0], score: [g.score, h.s0], bases, r0: h.r0, slot: [g.bat().slot, h.lp] }); }
      playAI(sc, sh, 'st-' + row.id + st.idx, { startIdx: st.idx });
      n++;
    } catch (e) { err++; console.log('ERROR', row.id, st.label, e.stack.split('\n').slice(0, 3).join(' | ')); }
  }
}
console.log('start points played', n, 'problems', err);
// grading timing at a big moment: Gibson
const sh = shard('s-1980.json'), sc = sh.scenarios['LAN198810150'];
const g = createGame(sc, sh, { userSide: 1, seed: 'g', startIdx: sc.starts.find((s) => s.label === 'The moment').idx });
let t = performance.now();
const off = gradeOffense(g, { tactic: 'swing' });
console.log('offense options', off.results.length, 'ms', (performance.now() - t).toFixed(0), 'best', off.best.batter, off.best.tactic, (off.best.wp * 100).toFixed(1), 'swing-away-with-Pena', (off.mine * 100).toFixed(1));
console.log(off.results.slice(0, 6).map((r) => `${g.P(r.batter).l}/${r.runners.map(x=>x?g.P(x).l:'-').join(',')}/${r.tactic} ${(r.wp * 100).toFixed(1)}`).join('\n'));
const g2 = createGame(sc, sh, { userSide: 0, seed: 'g', startIdx: sc.starts.find((s) => s.label === 'Bottom of the 9th').idx });
t = performance.now();
const def = gradeDefense(g2, { pid: g2.fld().pitcher });
console.log('defense options', def.results.length, 'ms', (performance.now() - t).toFixed(0), 'stay with', g2.P(g2.fld().pitcher).l, (def.mine * 100).toFixed(1), 'best', g2.P(def.best.pid).l, def.best.ibb, JSON.stringify(def.best.align), (def.best.wp * 100).toFixed(1));
console.log('WP now (home)', (winProb(g2) * 100).toFixed(1));
