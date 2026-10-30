// The grader should not prefer a drag bunt over swinging away down two in the 9th.
import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { evalOffense, forSide } from '../web/js/engine/evaluate.js';
const sh = JSON.parse(readFileSync(new URL('../web/data/s-1960.json', import.meta.url)));
const sc = sh.scenarios['PIT196010130'];
const g = createGame(sc, sh, { userSide: 0, seed: 't' });
const swing = forSide(evalOffense(g, { tactic: 'swing' }).wp, 0);
const drag = forSide(evalOffense(g, { tactic: 'drag' }).wp, 0);
console.log(`${g.P(g.batter().pid).n} (speed ${g.P(g.batter().pid).spd}): swing ${(swing * 100).toFixed(1)}%, drag bunt ${(drag * 100).toFixed(1)}%`);
if (drag > swing) { console.log('FAIL: drag bunt graded better than swinging away'); process.exit(1); }
console.log('PASS');
