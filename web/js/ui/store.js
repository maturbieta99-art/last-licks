// Per-viewer records kept in this browser. Every read and write is guarded:
// private windows and blocked storage just mean nothing is remembered.

const KEY = 'lastlicks.v1';
const blank = () => ({
  played: {}, daily: {}, streak: { cur: 0, best: 0, lastDay: 0 },
  survivor: { best: 0, run: null },
  totals: { games: 0, wins: 0, calls: { green: 0, yellow: 0, orange: 0, red: 0 },
    moves: { pitch: 0, ph: 0, pr: 0, bunt: 0, steal: 0, hitrun: 0, ibb: 0, visit: 0, def: 0, squeeze: 0 } },
  settings: { theme: 'system', calls: 'manual' },
});

let mem = null;
export function load() {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(KEY);
    mem = raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch {
    mem = blank();
  }
  return mem;
}
export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* not remembered */ }
}
export function settings() { return load().settings; }
export function setSetting(k, v) { load().settings[k] = v; save(); }

// record a finished game
export function recordGame(r) {
  const s = load();
  const p = s.played[r.id] || (s.played[r.id] = { w: 0, l: 0 });
  if (r.won) p.w++; else p.l++;
  p.last = { won: r.won, score: r.score, side: r.side, grades: r.grades, when: Date.now() };
  s.totals.games++;
  if (r.won) s.totals.wins++;
  for (const gr of r.grades) s.totals.calls[gr] = (s.totals.calls[gr] || 0) + 1;
  for (const [k, v] of Object.entries(r.moves || {})) s.totals.moves[k] = (s.totals.moves[k] || 0) + v;
  if (r.mode === 'daily' && !s.daily[r.day]) {
    s.daily[r.day] = { id: r.id, won: r.won, score: r.score, side: r.side, grades: r.grades };
    if (s.streak.lastDay === r.day - 1) s.streak.cur++;
    else if (s.streak.lastDay !== r.day) s.streak.cur = 1;
    s.streak.lastDay = r.day;
    s.streak.best = Math.max(s.streak.best, s.streak.cur);
  }
  save();
}

export function managerStyle(t) {
  const g = Math.max(1, t.games);
  const m = t.moves;
  const per = (k) => (m[k] || 0) / g;
  if (t.games < 3) return null;
  const styles = [
    { name: 'Sparky Anderson', why: 'Captain Hook: you go to the bullpen early and often.', score: per('pitch') * 1.4 },
    { name: 'Whitey Herzog', why: 'Speed and pressure: steals and hit-and-runs.', score: (per('steal') + per('hitrun')) * 1.6 },
    { name: 'Billy Martin', why: 'Squeezes, bunts and nerve.', score: (per('squeeze') * 2 + per('bunt')) * 1.5 },
    { name: 'Casey Stengel', why: 'You play the matchups off the bench.', score: (per('ph') + per('pr')) * 1.2 },
    { name: 'Tony La Russa', why: 'Every matchup managed: bullpen moves and pinch hitters.', score: (per('pitch') + per('ph')) * 0.9 },
    { name: 'Joe Maddon', why: 'Unconventional: walks, shifts and defensive tinkering.', score: (per('ibb') + per('def')) * 1.5 },
    { name: 'Earl Weaver', why: 'No bunts, no gimmicks. Pitching, defense and the three-run homer.', score: 0.55 - per('bunt') - per('steal') * 0.5 },
  ];
  styles.sort((a, b) => b.score - a.score);
  return styles[0];
}
