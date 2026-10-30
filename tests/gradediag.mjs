// Diagnose grading: what does the grader prefer over swinging away?
import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { gradeOffense, gradeDefense } from '../web/js/engine/evaluate.js';
const sh = JSON.parse(readFileSync(new URL('../web/data/s-2000.json', import.meta.url)));
const sc = sh.scenarios['BOS200410170'];
const tally = {};
for (let k = 0; k < sc.history.length; k++) {
  const h = sc.history[k], prev = sc.history[k - 1];
  if (!(k === 0 || prev.pa || prev.i !== h.i || prev.h !== h.h || prev.lp !== h.lp)) continue;
  const g = createGame(sc, sh, { userSide: -1, seed: 'd', startIdx: k });
  if (g.over) break;
  if (g.half === 1) {
    const r = gradeOffense(g, { batter: g.batter().pid, runners: g.bases.map((x) => x && x.pid), tactic: 'swing' });
    const b = r.best;
    const key = (b.batter !== g.batter().pid ? 'PH ' : '') + b.tactic;
    tally[key] = (tally[key] || 0) + 1;
    console.log(`B${h.i} ${h.o0}out ${g.bases.map((x) => (x ? 'X' : '-')).join('')} ${g.P(g.batter().pid).l.padEnd(10)} swing ${(r.mine * 100).toFixed(1)} | best ${key} ${(b.wp * 100).toFixed(1)} (${r.grade}) | ${r.results.slice(0, 4).map((x) => `${x.tactic}${x.batter !== g.batter().pid ? '/PH' : ''} ${(x.wp * 100).toFixed(1)}`).join(', ')}`);
  } else {
    const r = gradeDefense(g, { pid: g.fld().pitcher, ibb: false, align: { inf: 'normal', of: 'normal' } }, { pid: g.fld().pitcher });
    const b = r.best;
    const key = (b.pid !== g.fld().pitcher ? 'new P ' : '') + (b.ibb ? 'IBB ' : '') + b.align.inf + '/' + b.align.of;
    tally['D:' + key] = (tally['D:' + key] || 0) + 1;
    console.log(`T${h.i} ${h.o0}out ${g.bases.map((x) => (x ? 'X' : '-')).join('')} vs ${g.P(g.batter().pid).l.padEnd(10)} stay ${(r.mine * 100).toFixed(1)} | best ${key} ${(b.wp * 100).toFixed(1)} (${r.grade})`);
  }
}
console.log(tally);
