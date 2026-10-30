// Alignment-only value with the same pitcher, across several scenarios.
import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { evalDefense, forSide } from '../web/js/engine/evaluate.js';
const files = ['s-2000.json', 's-1980.json', 's-1990.json'];
const deltas = { deep: [], shallow: [], in: [], dp: [] };
for (const f of files) {
  const sh = JSON.parse(readFileSync(new URL('../web/data/' + f, import.meta.url)));
  for (const sc of Object.values(sh.scenarios).slice(0, 25)) {
    for (let k = 0; k < sc.history.length; k++) {
      const h = sc.history[k], prev = sc.history[k - 1];
      if (!(k === 0 || prev.pa || prev.i !== h.i || prev.h !== h.h || prev.lp !== h.lp)) continue;
      const g = createGame(sc, sh, { userSide: -1, seed: 'a', startIdx: k });
      if (g.over || !g.fld().pitcher) continue;
      const side = 1 - g.half;
      const pid = g.fld().pitcher;
      const base = forSide(evalDefense(g, { pid, align: { inf: 'normal', of: 'normal' } }).wp, side);
      const v = (al) => forSide(evalDefense(g, { pid, align: { ...g.fld().align, ...al } }).wp, side) - base;
      deltas.deep.push(v({ of: 'deep' }));
      if (g.bases[1] || g.bases[2]) deltas.shallow.push(v({ of: 'shallow' }));
      if (g.bases[2] && g.outs < 2) deltas.in.push(v({ inf: 'in' }));
      if (g.bases[0] && g.outs < 2) deltas.dp.push(v({ inf: 'dp' }));
    }
  }
}
for (const [k, arr] of Object.entries(deltas)) {
  arr.sort((a, b) => a - b);
  const avg = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  const pos = arr.filter((x) => x > 0.0075).length;
  console.log(`${k.padEnd(8)} n=${arr.length} avg ${(avg * 100).toFixed(2)} pts, median ${(arr[Math.floor(arr.length / 2)] * 100).toFixed(2)}, max ${(arr[arr.length - 1] * 100).toFixed(2)}, worth >0.75 pts in ${pos}`);
}
