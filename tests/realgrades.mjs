// Distribution of grades the real managers receive (sanity check for the grader).
import { readFileSync } from 'node:fs';
import { realManagerCalls } from '../web/js/ui/views.js';
const index = JSON.parse(readFileSync(new URL('../web/data/index.json', import.meta.url)));
const shards = {};
const tally = { green: 0, yellow: 0, orange: 0, red: 0 };
const worst = [];
for (const row of index.slice(0, 40)) {
  const sh = (shards[row.shard] ||= JSON.parse(readFileSync(new URL('../web/data/' + row.shard, import.meta.url))));
  const sc = sh.scenarios[row.id];
  for (const side of [0, 1]) {
    for (const c of realManagerCalls(sc, sh, side)) {
      tally[c.grade]++;
      if (c.grade === 'red') worst.push(`${row.title} (${sc.teams[side].nick}): ${c.desc} -> best ${c.best} +${(c.delta * 100).toFixed(1)}`);
    }
  }
}
const n = Object.values(tally).reduce((a, b) => a + b, 0);
console.log(Object.entries(tally).map(([k, v]) => `${k} ${(100 * v / n).toFixed(0)}%`).join('  '), `(${n} calls)`);
console.log(worst.slice(0, 15).join('\n'));
