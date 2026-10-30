// Play scenarios headlessly with the AI managing both teams.
// usage: node tests/simall.mjs [count] [startRank]
import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { aiPrePA, aiSign, aiDefensePitch } from '../web/js/engine/ai.js';
import { winProb } from '../web/js/engine/evaluate.js';

const N = +(process.argv[2] || 40);
const START = +(process.argv[3] || 1);
const index = JSON.parse(readFileSync(new URL('../web/data/index.json', import.meta.url)));
const shards = {};
const shard = (f) => (shards[f] ||= JSON.parse(readFileSync(new URL('../web/data/' + f, import.meta.url))));

export function playAI(sc, sh, seed, opts = {}) {
  const g = createGame(sc, sh, { userSide: -1, seed, startIdx: opts.startIdx || 0 });
  let lastKey = null, plan = null, guard = 0;
  while (!g.over && guard++ < 4000) {
    const key = g.paNo + ':' + g.inning + ':' + g.half;
    if (key !== lastKey) {
      lastKey = key;
      aiPrePA(g, 1 - g.half);
      if (g.over) break;
      if (g.paNo + ':' + g.inning + ':' + g.half !== key) continue; // IBB ended the PA
      plan = aiPrePA(g, g.half);
    }
    if (g.pending) { if (g.pending.resolve) g.answer(true); else break; continue; }
    g.pitch({ sign: aiSign(g, plan), defense: aiDefensePitch(g) });
  }
  if (guard >= 4000) throw new Error('stuck');
  return g;
}

if (process.argv[1] && process.argv[1].endsWith('simall.mjs')) {
  let errors = 0, games = 0, sameWinner = 0, halves = 0, runs = 0, pas = 0, pitches = 0, extra = 0;
  const t0 = performance.now();
  for (const row of index.slice(START - 1, START - 1 + N)) {
    const sh = shard(row.shard);
    const sc = sh.scenarios[row.id];
    try {
      const g = playAI(sc, sh, 'sim-' + row.id);
      games++;
      if (g.winner === (sc.final[1] > sc.final[0] ? 1 : 0)) sameWinner++;
      const lineRuns = g.line[0].slice(8).concat(g.line[1].slice(8));
      runs += lineRuns.reduce((a, b) => a + (b || 0), 0);
      halves += g.log.filter((e) => e.kind === 'halfStart').length;
      pas += g.paNo;
      pitches += g.pitchNo;
      if (g.inning > 9) extra++;
    } catch (e) {
      errors++;
      console.log('ERROR', row.rank, row.id, e.stack.split('\n').slice(0, 4).join(' | '));
    }
  }
  const ms = performance.now() - t0;
  console.log(`games ${games} errors ${errors} | same winner as history ${(100 * sameWinner / Math.max(1, games)).toFixed(0)}% | extras ${extra}`);
  console.log(`runs per half-inning ${(runs / Math.max(1, halves)).toFixed(3)} | PA/game ${(pas / games).toFixed(1)} | pitches/PA ${(pitches / Math.max(1, pas)).toFixed(2)} | ${(ms / Math.max(1, games)).toFixed(0)} ms/game`);
}
