// Team colors tuned to read on a black background: [primary, alternate].
// Used as accents so every game wears its two teams' colors.

const COLORS = {
  ANA: ['#e0464b', '#c4ced4'], CAL: ['#e0464b', '#5b7fc4'], ARI: ['#d43a52', '#3fb5a8'],
  ATL: ['#d8424f', '#5b7fc4'], BAL: ['#f06a26', '#c4ced4'], BOS: ['#d9474c', '#5b7fc4'],
  BRO: ['#3f7fd8', '#c4ced4'], BSN: ['#cf4a43', '#5b7fc4'], CHA: ['#c4ced4', '#8e9aa6'],
  CHN: ['#3f6fdb', '#e0484a'], CIN: ['#e2343f', '#c4ced4'], CLE: ['#d6404e', '#5b7fc4'],
  COL: ['#8b63d6', '#c4ced4'], DET: ['#f27a3c', '#5b7fc4'], FLO: ['#18aab3', '#f2a03a'],
  MIA: ['#25a9e6', '#f05a5a'], HOU: ['#f07a2a', '#5b7fc4'], KCA: ['#3f78d8', '#c9a646'],
  LAN: ['#3f86e0', '#e84a50'], MIL: ['#e8b62e', '#5b7fc4'], MIN: ['#d63f58', '#5b7fc4'],
  MLN: ['#d2443f', '#5b7fc4'], MON: ['#3f7ad8', '#e04a4f'], NY1: ['#f46a2c', '#c4ced4'],
  NYA: ['#6f92d6', '#c4ced4'], NYN: ['#3b6fe0', '#f57a32'], OAK: ['#2fa865', '#efb21e'],
  PHA: ['#6f92d6', '#c4ced4'], PHI: ['#e6343f', '#5b7fc4'], PIT: ['#f2bb2b', '#c4ced4'],
  SDN: ['#d2a33a', '#c4ced4'], SEA: ['#24a69d', '#5b7fc4'], SFN: ['#f46a2c', '#c4ced4'],
  SLA: ['#d47a35', '#c4ced4'], SLN: ['#da3a52', '#f2c94c'], TBA: ['#8fbce6', '#f2c94c'],
  TEX: ['#3f72de', '#e04a4f'], TOR: ['#3f86de', '#c4ced4'], WAS: ['#d93a43', '#5b7fc4'],
  WS1: ['#d24a4a', '#5b7fc4'],
};
const FALLBACK = [['#5b8ee0', '#c4ced4'], ['#e0604f', '#c4ced4']];

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function distance(a, b) {
  const [r1, g1, b1] = hexRgb(a), [r2, g2, b2] = hexRgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

// Colors for a matchup; the visitors switch to their alternate if the two clash.
export function teamColors(visCode, homeCode) {
  const v = COLORS[visCode] || FALLBACK[0];
  const h = COLORS[homeCode] || FALLBACK[1];
  let away = v[0];
  if (distance(away, h[0]) < 90) away = distance(v[1], h[0]) >= 90 ? v[1] : '#c4ced4';
  return [away, h[0]];
}
