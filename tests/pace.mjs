// How often the game stops for the player under the default pacing (first
// pitch of each at-bat, three balls or two strikes, runners moved, or a bunt
// or steal sign earlier in the at-bat) versus calling every pitch. Mirrors
// shouldAuto() in web/js/ui/play.js; the AI stands in for the player.
// usage: node tests/pace.mjs [count]
import { readFileSync } from 'node:fs';
import { createGame } from '../web/js/engine/game.js';
import { aiPrePA, aiSign, aiDefensePitch } from '../web/js/engine/ai.js';

const N = +(process.argv[2] || 500);
const index = JSON.parse(readFileSync(new URL('../web/data/index.json', import.meta.url)));
const shards = {};
const shard = (f) => (shards[f] ||= JSON.parse(readFileSync(new URL('../web/data/' + f, import.meta.url))));
const basesKey = (g) => g.bases.map((r) => (r ? r.pid : '-')).join(',');

let games = 0, every = 0, stops = 0;
for (const row of index.slice(0, N)) {
  const sh = shard(row.shard);
  const sc = sh.scenarios[row.id];
  const g = createGame(sc, sh, { userSide: -1, seed: 'pace-' + row.id });
  let lastKey = null, plan = null, guard = 0, paBases = '', tactic = false;
  while (!g.over && guard++ < 4000) {
    const key = g.paNo + ':' + g.inning + ':' + g.half;
    if (key !== lastKey) {
      lastKey = key;
      aiPrePA(g, 1 - g.half);
      if (g.over) break;
      if (g.paNo + ':' + g.inning + ':' + g.half !== key) continue;
      plan = aiPrePA(g, g.half);
      paBases = basesKey(g);
      tactic = false;
    }
    if (g.pending) { if (g.pending.resolve) { g.answer(true); stops++; } else break; continue; }
    const sign = aiSign(g, plan);
    const stop = !g.paStarted || g.count.b === 3 || g.count.s === 2 || basesKey(g) !== paBases || tactic;
    every++;
    if (stop) stops++;
    if (sign.bunt || sign.steal || sign.hitRun) tactic = true;
    g.pitch({ sign, defense: aiDefensePitch(g) });
  }
  games++;
}
console.log(`games ${games} | pitches per game ${(every / games).toFixed(1)} | the game stops you ${(stops / games).toFixed(1)} times per game (${(100 * stops / every).toFixed(0)}% of pitches)`);
