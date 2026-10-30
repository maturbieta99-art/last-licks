// Win-probability sanity checks with league-average lineups.
import { readFileSync } from 'node:fs';
import { transitions, halfTable, runDist, homeWP, extraTied, avgFresh, MAXR } from '../web/js/engine/wp.js';

const shard = JSON.parse(readFileSync(new URL('../web/data/s-1980.json', import.meta.url)));
for (const season of ['1985', '1988']) {
  const lg = shard.league[season];
  const L = lg.all;
  const avgDist = { K: L.k, BB: L.bb, HBP: L.hbp, HR: L.hr, B1: L.b1, B2: L.b2, B3: L.b3 };
  avgDist.OUT = 1 - Object.values(avgDist).reduce((a, b) => a + b, 0);
  const t0 = performance.now();
  const TR = transitions({ roe: lg.roe });
  const t1 = performance.now();
  const R = halfTable(Array(9).fill(avgDist), TR);
  const t2 = performance.now();
  const fresh = avgFresh(R);
  const ev = fresh.reduce((s, p, r) => s + p * r, 0);
  const X = extraTied(fresh, fresh);
  console.log(`${season}: transitions ${(t1 - t0).toFixed(1)}ms, table ${(t2 - t1).toFixed(1)}ms, runs/inning ${ev.toFixed(3)}, P(0 runs) ${fresh[0].toFixed(3)}`);
  const sum = fresh.reduce((a, b) => a + b, 0);
  console.log('   mass', sum.toFixed(4), 'extra tied home WP', X.toFixed(3));
  const cases = [
    ['top 9 tied, none on', 0, 0, 0, 0],
    ['bot 9 tied, none on', 1, 0, 0, 0],
    ['bot 9 down 1, none out', 1, 0, 0, -1],
    ['bot 9 down 1, 2 out, man on 1st', 1, 2, 1, -1],
    ['bot 9 down 1, 2 out, man on 2nd', 1, 2, 2, -1],
    ['bot 9 down 1, 0 out, man on 1st', 1, 0, 1, -1],
    ['bot 9 tied, 1 out, man on 3rd', 1, 1, 4, 0],
    ['top 9 home up 1', 0, 0, 0, 1],
    ['top 9 home down 2', 0, 0, 0, -2],
  ];
  for (const [label, half, outs, mask, diff] of cases) {
    const cur = runDist(R, outs, mask, 0);
    const wp = homeWP(half, diff, cur, fresh, X);
    console.log('  ', label.padEnd(36), (wp * 100).toFixed(1) + '%');
  }
}
