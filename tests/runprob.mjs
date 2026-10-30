// Probability of scoring at least one run from each base-out state, league average,
// compared with typical real-world rates (1993-2010 era).
import { readFileSync } from 'node:fs';
import { transitions, halfTable, runDist } from '../web/js/engine/wp.js';
const sh = JSON.parse(readFileSync(new URL('../web/data/s-2000.json', import.meta.url)));
const L = sh.league['2004'].all;
const d = { K: L.k, BB: L.bb, HBP: L.hbp, HR: L.hr, B1: L.b1, B2: L.b2, B3: L.b3 };
d.OUT = 1 - Object.values(d).reduce((a, b) => a + b, 0);
const R = halfTable(Array(9).fill(d), transitions({ roe: sh.league['2004'].roe }));
const real = { '0-0': 0.29, '0-1': 0.43, '0-2': 0.62, '0-4': 0.85, '0-3': 0.62, '1-0': 0.17, '1-1': 0.28, '1-2': 0.41, '1-4': 0.67, '2-0': 0.07, '2-1': 0.13, '2-2': 0.23, '2-4': 0.27 };
const names = { 0: 'empty', 1: '1st', 2: '2nd', 4: '3rd', 3: '1st+2nd' };
let rows = [];
for (const [k, r] of Object.entries(real)) {
  const [o, m] = k.split('-').map(Number);
  let p = 0;
  for (let s = 0; s < 9; s++) p += (1 - runDist(R, o, m, s)[0]) / 9;
  rows.push(`${o} out, ${(names[m] || m).padEnd(8)} model ${(p * 100).toFixed(0)}%  real ~${(r * 100).toFixed(0)}%`);
}
console.log(rows.join('\n'));
