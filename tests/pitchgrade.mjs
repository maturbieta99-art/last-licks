// How far single pitch calls fall from the best one, in win-probability
// points, for the catcher's call, a random spot, and swinging away without a
// look. Used to set the pitch-call grade scale (pitchGradeOf).
// usage: node tests/pitchgrade.mjs [games]
import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { aiPrePA, aiSign, aiDefensePitch } from '../web/js/engine/ai.js';
import { pitchOutcomes, pitchValue, pitchGradeOf, forSide } from '../web/js/engine/evaluate.js';
import { cellIndex } from '../web/js/engine/pitch.js';

const N = +(process.argv[2] || 30);
const index = JSON.parse(readFileSync(new URL('../web/data/index.json', import.meta.url)));
const shards = {};
const shard = (f) => (shards[f] ||= JSON.parse(readFileSync(new URL('../web/data/' + f, import.meta.url))));
const LOOKS = [null];
for (let v = -1; v <= 1; v++) for (let h = -1; h <= 1; h++) if (h || v) LOOKS.push(cellIndex(h, v));
const row = (S, t) => Array.from({ length: 25 }, (_, a) => S[t * 25 + a]);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return (s[Math.floor(p * (s.length - 1))] * 100).toFixed(2); };

const catcher = [], random = [], plain = [];
const grades = { catcher: {}, random: {}, plain: {} };
for (const r of index.slice(0, N)) {
  const sh = shard(r.shard);
  const g = createGame(sh.scenarios[r.id], sh, { userSide: -1, seed: 'pg-' + r.id });
  let lastKey = null, plan = null, guard = 0;
  while (!g.over && guard++ < 400) {
    const key = g.paNo + ':' + g.inning + ':' + g.half;
    if (key !== lastKey) {
      lastKey = key;
      aiPrePA(g, 1 - g.half);
      if (g.over) break;
      if (g.paNo + ':' + g.inning + ':' + g.half !== key) continue;
      plan = aiPrePA(g, g.half);
    }
    if (g.pending) { if (g.pending.resolve) g.answer(true); else break; continue; }
    const O = pitchOutcomes(g);
    if (O) {
      const M = O.M, count = `${g.count.b}-${g.count.s}`, fs = 1 - g.half;
      // pitcher's side
      let best = -1;
      const val = {};
      M.types.forEach((t, ti) => {
        for (let tg = 0; tg < 25; tg++) {
          const v = forSide(pitchValue(O, [[1, ti, row(M.scatter[ti], tg)]], count, 'normal', null, g.seq), fs);
          val[ti * 25 + tg] = v;
          if (v > best) best = v;
        }
      });
      const auto = forSide(pitchValue(O, M.autoActual(count).map((x, ti) => [x.p, ti, x.actual]), count, 'normal', null, g.seq), fs);
      const rnd = val[Math.floor(Math.random() * M.types.length) * 25 + Math.floor(Math.random() * 25)];
      catcher.push(best - auto); random.push(best - rnd);
      grades.catcher[pitchGradeOf(best - auto)] = (grades.catcher[pitchGradeOf(best - auto)] || 0) + 1;
      grades.random[pitchGradeOf(best - rnd)] = (grades.random[pitchGradeOf(best - rnd)] || 0) + 1;
      // hitter's side
      const mix = M.autoActual(count).map((x, ti) => [x.p, ti, x.actual]);
      let bestB = -1;
      for (const ap of ['normal', 'take', 'sitFB', 'protect']) {
        for (const lk of ap === 'take' ? [null] : LOOKS) bestB = Math.max(bestB, forSide(pitchValue(O, mix, count, ap, lk, g.seq), g.half));
      }
      const p0 = forSide(pitchValue(O, mix, count, 'normal', null, g.seq), g.half);
      plain.push(bestB - p0);
      grades.plain[pitchGradeOf(bestB - p0)] = (grades.plain[pitchGradeOf(bestB - p0)] || 0) + 1;
    }
    g.pitch({ sign: aiSign(g, plan), defense: aiDefensePitch(g) });
  }
}
for (const [name, a] of [['catcher call', catcher], ['random spot', random], ['swing away, no look', plain]]) {
  console.log(`${name}: n ${a.length} | median ${q(a, 0.5)} | p75 ${q(a, 0.75)} | p90 ${q(a, 0.9)} | p97 ${q(a, 0.97)} pts`);
}
console.log('grades', JSON.stringify(grades));
