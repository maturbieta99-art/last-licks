// Calibration check: the catcher's-call policy must reproduce the odds-ratio
// targets for real matchups, and live sampling must agree with the solver.
import { readFileSync } from 'node:fs';
import { buildMatchup, paDist, catcherCall, deliver, resolveAtPlate } from '../web/js/engine/pitch.js';
import { fatigue } from '../web/js/engine/model.js';
import { makeRng } from '../web/js/engine/rng.js';

const shard = JSON.parse(readFileSync(new URL('../web/data/s-1980.json', import.meta.url)));
const P = shard.players;
const lg = shard.league['1988'];
const pairs = [
  ['gibsk001:1988', 'ecked001:1988'],
  ['davim002:1988', 'ecked001:1988'],
  ['sciom001:1988', 'stewd001:1988'],
  ['cansj001:1988', 'herso001:1988'],
  ['herso001:1988', 'stewd001:1988'],
];
let worst = 0;
for (const [b, p] of pairs) {
  const batter = P[b], pitcher = P[p];
  const t0 = performance.now();
  const M = buildMatchup(batter, pitcher, { lg, tired: fatigue(pitcher, 0, 1, false), tto: 0 });
  const ms = performance.now() - t0;
  const d = paDist(M, 0, 0);
  const T = M.target;
  const row = ['K', 'BB', 'HBP', 'HR', 'B1', 'B2', 'B3', 'OUT'].map((k) => {
    const err = Math.abs(d[k] - T[k]);
    worst = Math.max(worst, err);
    return `${k} ${(T[k] * 100).toFixed(1)}/${(d[k] * 100).toFixed(1)}`;
  });
  console.log(`${batter.n} vs ${pitcher.n} [${ms.toFixed(1)}ms] W=${M.W.toFixed(2)} Z=${M.Z.toFixed(3)} P/PA=${d.pitches.toFixed(2)}`);
  console.log('   target/solved', row.join('  '));
  // live sampling agreement
  const rng = makeRng('calib' + b);
  const tally = { K: 0, BB: 0, HBP: 0, HR: 0, B1: 0, B2: 0, B3: 0, OUT: 0 };
  let pitches = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    let balls = 0, strikes = 0;
    const seq = [];
    for (;;) {
      const count = `${balls}-${strikes}`;
      const call = catcherCall(M, count, rng);
      const cell = deliver(M, call.ti, call.target, rng);
      const res = resolveAtPlate(M, cell, call.ti, count, 'normal', null, rng);
      pitches++;
      seq.push({ ti: call.ti, cell });
      if (res.kind === 'ball') { if (++balls === 4) { tally.BB++; break; } }
      else if (res.kind === 'called' || res.kind === 'swinging') { if (++strikes === 3) { tally.K++; break; } }
      else if (res.kind === 'foul') { if (strikes < 2) strikes++; }
      else if (res.kind === 'hbp') { tally.HBP++; break; }
      else { tally[res.result === 'OUT' ? 'OUT' : res.result]++; break; }
    }
  }
  console.log('   sampled      ', Object.entries(tally).map(([k, v]) => `${k} ${(v / N * 100).toFixed(1)}`).join('  '), `P/PA ${(pitches / N).toFixed(2)}`);
}
console.log('worst solver error (pts):', (worst * 100).toFixed(2));
