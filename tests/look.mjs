// Is "look for a pitch here" fair? For real matchups and every count, compare
// the run value of one pitch when the hitter sits on each part of the zone
// against not guessing. A blind guess (any of the nine spots, picked at random)
// should be worth about nothing; picking where this pitcher throws in this
// count should pay. The looks are the eight directions around the middle
// (sitting on the middle is no look). Uses the AI's catcher's-call pitch mix.
// usage: node tests/look.mjs [matchups]
import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { cellIndex, COUNTS, inLook } from '../web/js/engine/pitch.js';

const N = +(process.argv[2] || 150);
const index = JSON.parse(readFileSync(new URL('../web/data/index.json', import.meta.url)));
const shards = {};
const shard = (f) => (shards[f] ||= JSON.parse(readFileSync(new URL('../web/data/' + f, import.meta.url))));

// linear weights (runs) for how a plate appearance ends
const LW = { K: 0, BB: 0.69, HBP: 0.72, HR: 1.95, B3: 1.55, B2: 1.25, B1: 0.88, OUT: 0 };
const BIPW = [LW.HR, LW.B3, LW.B2, LW.B1, LW.OUT];
const LOOKS = [];
for (let v = -1; v <= 1; v++) for (let h = -1; h <= 1; h++) if (h || v) LOOKS.push(cellIndex(h, v));

function countValues(M) {
  const V = {};
  for (const c of COUNTS) {
    const v = M.V[c];
    V[c] = v[0] * LW.K + v[1] * LW.BB + v[2] * LW.HBP + v[3] * LW.HR + v[4] * LW.B3 + v[5] * LW.B2 + v[6] * LW.B1;
  }
  return V;
}

// expected run value of one pitch at a count, with an optional look
function pitchValue(M, V, b, s, look) {
  const count = `${b}-${s}`;
  const ballV = b === 3 ? LW.BB : V[`${b + 1}-${s}`];
  const strV = s === 2 ? LW.K : V[`${b}-${s + 1}`];
  const foulV = s === 2 ? V[count] : V[`${b}-${s + 1}`];
  let ev = 0;
  for (const [ti, { p, actual }] of M.autoActual(count).entries()) {
    for (let cell = 0; cell < 25; cell++) {
      const w = p * actual[cell];
      if (w < 1e-9) continue;
      const r = M.pitchProbs(cell, ti, count, 'normal', null, look);
      const d = M.bipDist(r.dmg);
      let bip = 0;
      for (let i = 0; i < 5; i++) bip += d[i] * BIPW[i];
      ev += w * (r.ball * ballV + (r.cstr + r.sstr) * strV + r.hbp * LW.HBP + r.foul * foulV + r.inplay * bip);
    }
  }
  return ev;
}

let n = 0, blind = 0, best = 0, worst = 0;
const byCount = {};
for (const row of index.slice(0, N)) {
  const sh = shard(row.shard);
  const g = createGame(sh.scenarios[row.id], sh, { userSide: -1, seed: 'look' });
  if (!g.fld().pitcher) continue;
  const M = g.matchup();
  const V = countValues(M);
  for (const c of COUNTS) {
    const [b, s] = c.split('-').map(Number);
    const base = pitchValue(M, V, b, s, null);
    const gains = LOOKS.map((lk) => pitchValue(M, V, b, s, lk) - base);
    const avg = gains.reduce((a, x) => a + x, 0) / gains.length;
    blind += avg;
    best += Math.max(...gains);
    worst += Math.min(...gains);
    (byCount[c] ||= []).push([avg, Math.max(...gains)]);
    n++;
  }
}
const f = (x) => (x * 1000).toFixed(1);
console.log(`per pitch, in thousandths of a run (${n} matchup-counts):`);
console.log(`  blind guess ${f(blind / n)} | best spot ${f(best / n)} | worst spot ${f(worst / n)}`);
for (const c of COUNTS) {
  const a = byCount[c];
  if (!a) continue;
  const m = (k) => a.reduce((x, y) => x + y[k], 0) / a.length;
  console.log(`  ${c}: blind ${f(m(0))}, best ${f(m(1))}`);
}
