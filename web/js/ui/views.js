// Screens other than the live game.
import { createGame, ordinal } from '../engine/game.js';
import { gradeDefense, gradeOffense } from '../engine/evaluate.js';
import { esc, pct, fmtDate, copyText, toast } from './util.js';
import { GRADE_EMOJI, TACTIC_LABEL } from './play.js';
import { load, managerStyle } from './store.js';

const ROUND_NAME = { worldseries: 'World Series', lcs: 'League Championship', divisionseries: 'Division Series', wildcard: 'Wild Card', playoff: 'Tiebreaker' };

export function situation(row, side) {
  const s9 = row.s9;
  const mine = s9[side], theirs = s9[1 - side];
  if (mine === theirs) return 'Tied';
  return mine > theirs ? `Up by ${mine - theirs}` : `Down by ${theirs - mine}`;
}
const resultBadge = (id) => {
  const p = load().played[id];
  if (!p || !p.last) return '';
  return p.last.won ? '<span class="badge w">Won</span>' : '<span class="badge l">Lost</span>';
};

// ---------------------------------------------------------------- home
export function homeHtml(app) {
  const st = load();
  const d = app.today;
  const day = app.dayNo;
  const done = st.daily[day];
  const s9 = d.s9;
  const side = d.side;
  const surv = st.survivor;
  const games = st.totals.games;
  const legends = app.index.filter((r) => r.legend).slice(0, 12);
  return `<div class="wrap">
    <div class="hero">
      <div class="today"><div class="lights"></div>
        <div class="eyebrow">Today's game · No. ${day} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
        <h1>${esc(d.title)}</h1>
        <div class="event">${esc(d.event)} · ${esc(d.teams[0])} at ${esc(d.teams[1])}</div>
        <div class="sit">${esc(situation(d, side))} · top of the 9th</div>
        <p class="intro">${esc(d.intro || '')} You manage the ${esc(d.teams[side])}.</p>
        ${done ? `<p>${done.won ? 'You won' : 'You lost'} today's game ${done.score[0]}-${done.score[1]} · ${done.grades.map((x) => GRADE_EMOJI[x]).join('')}</p>
          <div class="actions"><a class="btn primary" href="#s-${d.id}">Play it again</a></div>`
          : `<div class="actions"><a class="btn primary" href="#daily">Play today's game</a></div>`}
      </div>
      <div class="tiles">
        <a class="card tile" href="#survivor" style="text-decoration:none"><span class="eyebrow">Survivor</span><h3>${surv.run ? `Run alive: ${surv.run.wins} won` : 'One loss and you\'re out'}</h3>
          <p>Random historic 9th innings back to back. Best run: ${surv.best}.</p></a>
        <a class="card tile" href="#archive" style="text-decoration:none"><span class="eyebrow">The archive</span><h3>500 ninth innings</h3>
          <p>Every World Series, LCS, Division Series and Wild Card game since 1903 that came down to the last frames, plus the tiebreaker playoffs.</p></a>
        <a class="card tile" href="#stats" style="text-decoration:none"><span class="eyebrow">Your record</span><h3>${games ? `${st.totals.wins}-${games - st.totals.wins}` : 'No games yet'}</h3>
          <p>${games ? `Daily streak ${st.streak.cur} · ${st.totals.calls.green || 0} best calls` : 'Your wins, streaks and managing style show up here.'}</p></a>
      </div>
    </div>
    <div class="section-h"><h2>Legends</h2><a href="#archive" class="muted">See all 500</a></div>
    <div class="legend-grid">${legends.map(cardHtml).join('')}</div>
    ${footer()}
  </div>`;
}

function cardHtml(r) {
  return `<a class="sc-card" href="#s-${r.id}" style="text-decoration:none">
    <span class="rankno">No. ${r.rank} ${resultBadge(r.id)}</span>
    <span class="t">${esc(r.title)}</span>
    <span class="e">${esc(r.event)}</span>
    <span class="s">${esc(r.teams[0])} ${r.s9[0]}, ${esc(r.teams[1])} ${r.s9[1]} after 8</span></a>`;
}

export function footer() {
  return `<p class="footer-note">Not affiliated with, endorsed by or sponsored by Major League Baseball, its clubs or players. Team and player names identify real games only.
  The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd., Newark, DE 19711.
  Ratings are estimated from each player's real season statistics; pitch types for most pitchers are estimated from their profile.</p>`;
}

// ---------------------------------------------------------------- archive
export function archiveHtml(app, f) {
  const decades = [...new Set(app.index.map((r) => Math.floor(r.season / 10) * 10))].sort();
  const rows = filterIndex(app, f);
  const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`;
  return `<div class="wrap">
    <div class="section-h"><h2>The archive</h2><span class="muted">${rows.length} of 500 · ranked by stakes and ninth-inning drama</span></div>
    <div class="card filters">
      <input type="search" id="q" placeholder="Search a team, player, year…" value="${esc(f.q || '')}" aria-label="Search">
      <select id="fdec" aria-label="Decade">${opt('', 'Any decade', f.dec)}${decades.map((d) => opt(d, `${d}s`, f.dec)).join('')}</select>
      <select id="fround" aria-label="Round">${opt('', 'Any round', f.round)}${Object.entries(ROUND_NAME).map(([k, v]) => opt(k, v, f.round)).join('')}</select>
      <select id="fsit" aria-label="Situation">${opt('', 'Any score', f.sit)}${opt('tied', 'Tied after 8', f.sit)}${opt('1', 'One-run game', f.sit)}${opt('2', 'Two or three runs', f.sit)}</select>
      <select id="fplayed" aria-label="Played">${opt('', 'All', f.played)}${opt('new', 'Not played', f.played)}${opt('won', 'Won', f.played)}${opt('lost', 'Lost', f.played)}</select>
      <label class="chip"><input type="checkbox" id="flegend" ${f.legend ? 'checked' : ''}> Legends only</label>
    </div>
    <div class="list">${rows.slice(0, f.limit || 120).map((r) => `<a class="row" href="#s-${r.id}" style="text-decoration:none">
      <span class="rk">${r.rank}</span>
      <span style="min-width:0"><span class="t">${esc(r.title)}</span><br><span class="e">${esc(r.event)} · ${esc(r.teams[0])} ${r.s9[0]}, ${esc(r.teams[1])} ${r.s9[1]} after 8${r.inn > 9 ? ` · went ${r.inn}` : ''}</span></span>
      <span>${r.legend ? '<span class="badge">Legend</span> ' : ''}${resultBadge(r.id)}</span></a>`).join('')}</div>
    ${rows.length > (f.limit || 120) ? `<p style="text-align:center"><button class="btn" id="more">Show more</button></p>` : ''}
    ${footer()}</div>`;
}

export function filterIndex(app, f) {
  const q = (f.q || '').toLowerCase().trim();
  const st = load();
  return app.index.filter((r) => {
    if (f.legend && !r.legend) return false;
    if (f.dec && Math.floor(r.season / 10) * 10 !== +f.dec) return false;
    if (f.round && r.round !== f.round) return false;
    if (f.sit === 'tied' && r.margin !== 0) return false;
    if (f.sit === '1' && r.margin !== 1) return false;
    if (f.sit === '2' && (r.margin < 2 || r.margin > 3)) return false;
    const p = st.played[r.id];
    if (f.played === 'new' && p) return false;
    if (f.played === 'won' && !(p && p.last && p.last.won)) return false;
    if (f.played === 'lost' && !(p && p.last && !p.last.won)) return false;
    if (q) {
      const hay = `${r.title} ${r.event} ${r.teams.join(' ')} ${r.season} ${r.codes.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------- pregame
export function startLabel(sc, st) {
  if (st.idx === 0) return { title: 'The whole 9th', sub: 'Both halves: pitch to their lineup, then manage your at-bats.' };
  const h = sc.history[st.idx];
  const bases = h.r0.filter(Boolean).length;
  const occ = ['first', 'second', 'third'].filter((_, i) => h.r0[i]);
  const where = `${h.h ? 'Bottom' : 'Top'} ${ordinal(h.i)}, ${h.o0} out${bases ? `, ${occ.length === 3 ? 'bases loaded' : 'runner' + (occ.length > 1 ? 's' : '') + ' on ' + occ.join(' and ')}` : ''}, ${sc.teams[0].nick} ${h.s0[0]}, ${sc.teams[1].nick} ${h.s0[1]}`;
  if (st.label === 'Bottom of the 9th') return { title: 'Bottom of the 9th', sub: where };
  return { title: 'The moment', sub: `${where}. The at-bat that swung the game, before either manager's move.` };
}

export function pregameHtml(app, sc, choice) {
  const side = choice.side;
  const t = sc.teams;
  const row = app.index.find((r) => r.id === sc.id);
  const n = 8;
  const rules = [];
  rules.push(sc.rules.dh ? 'Designated hitter in use' : 'Pitchers hit (no DH)');
  if (sc.rules.three) rules.push('Three-batter minimum for relievers');
  if (!sc.rules.shift) rules.push('No infield shift');
  if (sc.rules.replay) rules.push('Replay review era');
  if (sc.rules.limitPO) rules.push('Two pickoff throws per batter');
  if (sc.rules.autoIBB) rules.push('Intentional walks are automatic');
  const daily = choice.mode === 'daily';
  return `<div class="wrap">
    <div class="pregame">
      <div class="today"><div class="lights"></div>
        <div class="eyebrow">${esc(sc.event)} · ${fmtDate(sc.date)}${sc.park ? ' · ' + esc(sc.park) : ''}</div>
        <h1>${esc(sc.title)}</h1>
        <div class="sit">${esc(situation(row, side))} going to the 9th</div>
        <p class="intro">${esc(sc.intro)}</p>
        <div class="board" style="margin-top:8px"><div class="board-scroll"><table aria-label="Line score through eight">
          <thead><tr><th></th>${Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr></thead>
          <tbody>${[0, 1].map((s) => `<tr><td class="name ${s === side ? 'me' : ''}"><i style="background:${s === 0 ? 'var(--away)' : 'var(--home)'}"></i>${esc(t[s].nick)}</td>
            ${sc.line[s].map((v) => `<td>${v}</td>`).join('')}<td class="rhe">${sc.score9[s]}</td><td class="rhe">${sc.start.he ? sc.start.he[s][0] : ''}</td><td class="rhe">${sc.start.he ? sc.start.he[s][1] : ''}</td></tr>`).join('')}</tbody></table></div></div>
      </div>
      <div class="card panel" style="align-content:start">
        <div class="eyebrow">${daily ? "Today's game" : `No. ${sc.rank} of 500`}${sc.stakes ? ' · ' + esc(sc.stakes) : ''} · ${esc(sc.series)}</div>
        <h3>Pick your dugout</h3>
        <div class="dugout-pick">${[0, 1].map((s) => `<button class="dugout" data-side="${s}" aria-pressed="${s === side}">
          <b>${esc(t[s].nick)}</b><small>${s === 0 ? 'Visitors' : 'Home'} · ${esc(situation(row, s))}</small><small>Real manager: ${esc(t[s].mgr || 'unknown')}</small></button>`).join('')}</div>
        <h3>Start at</h3>
        <div class="starts">${sc.starts.map((st, i) => {
          const l = startLabel(sc, st);
          return `<button class="start-opt" data-start="${i}" aria-pressed="${choice.start === i}"><b>${esc(l.title)}</b><br><span class="muted" style="font-size:13px">${esc(l.sub)}</span></button>`;
        }).join('')}</div>
        <div class="eyebrow">Rules for ${sc.rules.season}</div>
        <div class="chips">${rules.map((r) => `<span class="chip" style="cursor:default">${esc(r)}</span>`).join('')}</div>
        <div class="actions"><button class="btn primary" data-go>Play ball</button><a class="btn" href="#archive">Back to the archive</a></div>
        <p class="muted" style="font-size:13px;margin:0">You call your pitches and signs; the AI manages the ${esc(t[1 - side].nick)} and makes the real manager's moves when the game reaches the same spot.</p>
      </div>
    </div>${footer()}</div>`;
}

// ---------------------------------------------------------------- result
export function shareText(app, sc, res) {
  const t = sc.teams;
  const me = t[res.side].nick;
  const head = res.mode === 'daily' ? `Last Licks · Daily No. ${res.day}` : res.mode === 'survivor' ? `Last Licks · Survivor` : `Last Licks · No. ${sc.rank}`;
  const greens = res.grades.filter((x) => x === 'green').length;
  return `${head}\n${sc.title} (${sc.event})\n${me}: ${res.won ? 'WON' : 'LOST'} ${res.score[res.side]}-${res.score[1 - res.side]}\n${res.grades.map((x) => GRADE_EMOJI[x]).join('') || '(no calls)'}\n${greens} of ${res.grades.length} calls the best · started at ${pct(res.startWp || 0)} to win`;
}

export function resultHtml(app, sc, res, extra) {
  const t = sc.teams;
  const me = res.side;
  const realWin = sc.final[1] > sc.final[0] ? 1 : 0;
  const key = sc.history.reduce((best, h, i) => (Math.abs(h.dwe) > Math.abs(sc.history[best].dwe) ? i : best), 0);
  const changed = res.won && realWin !== me;
  const verdict = changed ? 'You changed history.' : res.won ? 'You matched history.' : realWin === me ? 'History says your team should have won this one.' : 'The ending held.';
  const counts = { green: 0, yellow: 0, orange: 0, red: 0 };
  res.grades.forEach((x) => { counts[x]++; });
  const callRows = res.gradeList.map((x) => `<div class="opt"><div><div class="nm"><span class="sq ${x.grade}"></span> ${esc(x.mine)}</div>
    <div class="meta">${x.half ? 'Bottom' : 'Top'} ${ordinal(x.inning)} · ${x.grade === 'green' ? 'the best call' : `best was ${esc(x.best)} (+${(x.delta * 100).toFixed(1)} pts)`}</div></div>
    <span class="num muted">${pct(x.mineWp)}</span></div>`).join('') || '<p class="muted">No calls this time.</p>';
  const surv = res.mode === 'survivor' ? extra.survivor : null;
  return `<div class="wrap">
    <div class="result">
      <div style="display:grid;gap:14px;align-content:start;min-width:0">
        <div class="banner"><div class="eyebrow" style="color:var(--board-dim)">${esc(sc.event)} · ${esc(sc.title)}</div>
          <h1 class="${res.won ? 'won' : ''}">${res.won ? 'You won' : 'You lost'} ${res.score[me]}-${res.score[1 - me]}</h1>
          <p style="margin:8px 0 0">${esc(verdict)} In ${sc.rules.season}, the ${esc(t[realWin].nick)} won ${Math.max(...sc.final)}-${Math.min(...sc.final)}${sc.innings > 9 ? ` in ${sc.innings}` : ''}. ${esc(sc.history[key].t)}</p>
          ${surv ? `<p style="margin:10px 0 0;font-weight:700">${esc(surv)}</p>` : ''}
          <div class="gridsq">${res.grades.map((x) => `<span class="sq ${x}" title="${x}"></span>`).join('')}</div>
          <div class="actions">${extra.next ? `<button class="btn primary" data-next>${esc(extra.next)}</button>` : ''}
            <button class="btn" data-again>Play it again</button><button class="btn" data-swap>Manage the ${esc(t[1 - me].nick)}</button><a class="btn" href="#archive" style="color:var(--ink)">Archive</a></div>
        </div>
        <div class="card panel"><h3>Win chance, your dugout</h3>${wpChart(res.wp)}</div>
        <div class="card panel"><h3><span>Your calls</span><span class="muted" style="font:600 13px var(--font-body);text-transform:none">${counts.green} best · ${counts.yellow} close · ${counts.orange} costly · ${counts.red} big miss</span></h3>${callRows}</div>
      </div>
      <div style="display:grid;gap:14px;align-content:start;min-width:0">
        <div class="card panel"><h3>Share</h3><div class="share-text" id="share">${esc(shareText(app, sc, res))}</div>
          <div class="actions"><button class="btn" data-copy>Copy result</button></div></div>
        <div class="card panel"><h3>The real manager</h3><div id="realcalls"><p class="muted">Grading ${esc(t[me].mgr || 'the real manager')}'s calls…</p></div></div>
        <div class="card panel"><h3>Film room: what really happened</h3>${filmRoom(sc)}</div>
      </div>
    </div>${footer()}</div>`;
}

function filmRoom(sc) {
  const key = sc.history.reduce((best, h, i) => (Math.abs(h.dwe) > Math.abs(sc.history[best].dwe) ? i : best), 0);
  let lastHalf = null;
  const rows = sc.history.map((h, i) => {
    let head = '';
    const hk = `${h.i}${h.h}`;
    if (hk !== lastHalf) { lastHalf = hk; head = `<div class="eyebrow" style="margin-top:6px">${h.h ? 'Bottom' : 'Top'} of the ${ordinal(h.i)}</div>`; }
    const subs = (h.subs || []).filter((s) => s.k !== 'pos').map((s) => {
      const team = sc.teams[s.t].nick;
      const verb = { pitch: 'bring in', ph: 'send up pinch hitter', pr: 'send in pinch runner', def: 'put in' }[s.k] || 'put in';
      return `<div class="sub">${esc(team)} ${verb} ${esc(nameOf(sc, s.in))}${s.out && s.k !== 'pitch' ? ` for ${esc(nameOf(sc, s.out))}` : ''}</div>`;
    }).join('');
    const homeWp = h.we + h.dwe;
    return `${head}<div class="r ${i === key ? 'key' : ''}"><span class="muted">${h.o0} out</span><span>${subs}${esc(h.t)}</span><span class="wpx">${pct(homeWp)}</span></div>`;
  }).join('');
  return `<div class="film">${rows}</div><p class="muted" style="font-size:12px;margin:6px 0 0">Right column: the home team's chance to win after each play, from a league-average model.</p>`;
}
const NAME_CACHE = new Map();
function nameOf(sc, pid) {
  const shard = NAME_CACHE.get('shard');
  if (shard) {
    const p = shard.players[`${pid}:${sc.rules.season}`];
    if (p) return p.n;
  }
  return pid;
}
export function setNameShard(shard) { NAME_CACHE.set('shard', shard); }

function wpChart(series) {
  if (!series || series.length < 2) return '<p class="muted">Not enough plays to chart.</p>';
  const W = 560, H = 190, L = 40, R = 12, T = 12, B = 26;
  const n = series.length;
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - v) * (H - T - B);
  let d = '';
  series.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.wp).toFixed(1)} `; });
  const grid = [0, 0.5, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" ${v === 0.5 ? 'stroke-dasharray="4 4"' : ''}/>
    <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--font-body)">${v * 100}%</text>`).join('');
  const last = series[n - 1];
  const pts = series.map((p, i) => `<rect x="${x(i) - (W - L - R) / (2 * (n - 1))}" y="${T}" width="${(W - L - R) / (n - 1)}" height="${H - T - B}" fill="transparent" data-i="${i}"/>`).join('');
  return `<div class="wpchart" style="position:relative">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Win chance from ${pct(series[0].wp)} to ${pct(last.wp)}">
      ${grid}
      <path d="${d}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(n - 1)}" cy="${y(last.wp)}" r="4" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>
      <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>
      <circle class="xd" r="4" fill="var(--series)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
      <text x="${L}" y="${H - 8}" font-size="11" fill="var(--muted)" font-family="var(--font-body)">${esc(series[0].label)}</text>
      <text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--font-body)">${esc(last.label)}</text>
      <g class="hits">${pts}</g>
    </svg>
    <div class="tip" hidden style="position:absolute;pointer-events:none;background:var(--ink);color:var(--surface);font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap"></div>
    <details style="margin-top:6px"><summary class="muted" style="font-size:12.5px">Show the numbers</summary>
      <table style="font-size:12.5px;border-collapse:collapse;margin-top:6px">${series.map((p) => `<tr><td style="padding:2px 10px 2px 0">${esc(p.label)}</td><td class="num">${pct(p.wp)}</td></tr>`).join('')}</table></details>
  </div>`;
}

export function wireChart(root, series) {
  const wrap = root.querySelector('.wpchart');
  if (!wrap || !series || series.length < 2) return;
  const svg = wrap.querySelector('svg');
  const tip = wrap.querySelector('.tip');
  const xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd');
  const W = 560, H = 190, L = 40, R = 12, T = 12, B = 26;
  const n = series.length;
  svg.addEventListener('mousemove', (e) => {
    const r = e.target.closest('[data-i]');
    if (!r) return;
    const i = +r.dataset.i;
    const px = L + (i / (n - 1)) * (W - L - R), py = T + (1 - series[i].wp) * (H - T - B);
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', px); xd.setAttribute('cy', py); xd.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${series[i].label}: ${pct(series[i].wp)}`;
    const box = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(box.width - 140, Math.max(0, (px / W) * box.width - 50))}px`;
    tip.style.top = `${(py / H) * box.height - 34}px`;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); });
}

// Grade the real manager's calls for one dugout by replaying history.
export function realManagerCalls(sc, shard, side) {
  const out = [];
  const hist = sc.history;
  for (let k = 0; k < hist.length; k++) {
    const h = hist[k];
    const prev = hist[k - 1];
    const paStart = k === 0 || prev.pa || prev.i !== h.i || prev.h !== h.h || prev.lp !== h.lp;
    if (!paStart) continue;
    try {
      const g = createGame(sc, shard, { userSide: -1, seed: 'real', startIdx: k });
      if (g.over) break;
      const subs = h.subs || [];
      g.applySubs(subs.filter((s) => s.t !== side));
      if (h.h !== side) {
        const pitch = subs.find((s) => s.t === side && s.k === 'pitch');
        const basePid = g.fld().pitcher;
        const pid = pitch && g.fld().pen.includes(pitch.in) ? pitch.in : basePid;
        const ibb = /^(IW|I)(\.|$|\+)/.test(h.ev);
        const r = gradeDefense(g, { pid, ibb, align: { inf: 'normal', of: 'normal' } }, { pid: basePid }, { fixedAlign: true });
        const pl = g.P(pid);
        const desc = `${pid !== basePid ? `Brought in ${pl.l}` : `Stayed with ${pl.l}`}${ibb ? ', walked him' : ''}`;
        const best = g.P(r.best.pid);
        out.push({ grade: r.grade, delta: r.delta, desc, best: `${r.best.pid !== basePid ? `bring in ${best.l}` : `stay with ${best.l}`}${r.best.ibb ? ', walk him' : ''}`, inning: h.i, half: h.h, batter: g.P(g.batter().pid).l });
      } else {
        const baseBatter = g.batter().pid;
        const ph = subs.find((s) => s.t === side && s.k === 'ph');
        const batter = ph && g.bat().bench.includes(ph.in) ? ph.in : baseBatter;
        const runners = g.bases.map((r) => (r ? r.pid : null));
        for (const s of subs.filter((x) => x.t === side && x.k === 'pr')) {
          const i = runners.indexOf(s.out);
          if (i >= 0) runners[i] = s.in;
        }
        let tactic = 'swing';
        const ev = h.ev;
        if (/^(SB|CS)2/.test(ev) || /SB2/.test(ev)) tactic = 'steal2';
        else if (/^(SB|CS)3/.test(ev)) tactic = 'steal3';
        else if (/^(SB|CS)H/.test(ev)) tactic = 'steal4';
        else if (/\/SH/.test(ev)) tactic = h.r0[2] && h.s1[side] > h.s0[side] ? 'squeeze' : 'sac';
        const r = gradeOffense(g, { batter, runners, tactic }, { batter: baseBatter, runners: g.bases.map((x) => (x ? x.pid : null)) });
        const bl = g.P(batter).l;
        const prDesc = runners.map((pid, i) => (pid && g.bases[i] && pid !== g.bases[i].pid ? `, ${g.P(pid).l} ran` : '')).join('');
        const desc = `${batter !== baseBatter ? `${bl} pinch-hit` : `${bl} hit`}${prDesc}, ${TACTIC_LABEL[tactic]}`;
        const bestDesc = `${r.best.batter !== baseBatter ? `${g.P(r.best.batter).l} pinch-hits` : `${g.P(r.best.batter).l} hits`}, ${TACTIC_LABEL[r.best.tactic]}`;
        out.push({ grade: r.grade, delta: r.delta, desc, best: bestDesc, inning: h.i, half: h.h, batter: bl });
      }
    } catch (e) { console.error(e); }
  }
  return out;
}

export function realCallsHtml(sc, side, calls) {
  if (!calls.length) return '<p class="muted">No decisions to grade.</p>';
  const greens = calls.filter((c) => c.grade === 'green').length;
  return `<p style="margin:0">${esc(sc.teams[side].mgr || 'The real manager')}: ${calls.map((c) => GRADE_EMOJI[c.grade]).join('')} · ${greens} of ${calls.length} best</p>
    ${calls.map((c) => `<div class="opt"><div><div class="nm"><span class="sq ${c.grade}"></span> ${esc(c.desc)}</div>
      <div class="meta">${c.half ? 'Bottom' : 'Top'} ${ordinal(c.inning)}${c.grade === 'green' ? '' : ` · best was ${esc(c.best)} (+${(c.delta * 100).toFixed(1)} pts)`}</div></div></div>`).join('')}
    <p class="muted" style="font-size:12px;margin:0">Their fielders' positioning isn't in the record, so these grades cover pitchers, walks, pinch hitters, runners, bunts and steals.</p>`;
}

// ---------------------------------------------------------------- stats
export function statsHtml(app) {
  const st = load();
  const t = st.totals;
  const style = managerStyle(t);
  const calls = t.calls;
  const total = (calls.green || 0) + (calls.yellow || 0) + (calls.orange || 0) + (calls.red || 0);
  const recent = Object.entries(st.played).filter(([, p]) => p.last).sort((a, b) => b[1].last.when - a[1].last.when).slice(0, 12);
  return `<div class="wrap">
    <div class="section-h"><h2>Your record</h2><span class="muted">Saved in this browser</span></div>
    <div class="stat-grid">
      <div class="card stat"><b class="num">${t.wins}-${t.games - t.wins}</b><span>Won-lost</span></div>
      <div class="card stat"><b class="num">${t.games ? pct(t.wins / t.games) : '—'}</b><span>Win rate</span></div>
      <div class="card stat"><b class="num">${st.streak.cur}</b><span>Daily streak (best ${st.streak.best})</span></div>
      <div class="card stat"><b class="num">${st.survivor.best}</b><span>Best Survivor run</span></div>
      <div class="card stat"><b class="num">${total ? pct((calls.green || 0) / total) : '—'}</b><span>Calls that were the best</span></div>
    </div>
    <div class="section-h"><h2>Who you manage like</h2></div>
    <div class="card panel">${style ? `<h3>${esc(style.name)}</h3><p style="margin:0">${esc(style.why)}</p>` : '<p class="muted" style="margin:0">Manage three games and your style shows up here.</p>'}
      <div class="gridsq">${['green', 'yellow', 'orange', 'red'].map((k) => `<span class="chip" style="cursor:default"><span class="sq ${k}"></span> ${calls[k] || 0}</span>`).join('')}</div></div>
    <div class="section-h"><h2>Recent games</h2></div>
    <div class="list">${recent.map(([id, p]) => {
      const r = app.index.find((x) => x.id === id);
      if (!r) return '';
      return `<a class="row" href="#s-${id}" style="text-decoration:none"><span class="rk">${r.rank}</span><span style="min-width:0"><span class="t">${esc(r.title)}</span><br><span class="e">${esc(r.event)} · managed the ${esc(r.teams[p.last.side])} · ${p.last.score[0]}-${p.last.score[1]}</span></span><span>${p.last.won ? '<span class="badge w">Won</span>' : '<span class="badge l">Lost</span>'}</span></a>`;
    }).join('') || '<p class="muted">Nothing yet.</p>'}</div>
    ${footer()}</div>`;
}

// ---------------------------------------------------------------- how to play
export function howtoHtml() {
  return `<div class="howto">
    <p>You're the manager for the 9th inning of a real postseason game: the real lineups, benches and bullpens, rated from that season's statistics. Win the game.</p>
    <ul>
      <li><b>When your team is in the field</b>, call each pitch: pick a pitch type, click a spot in the zone (catcher's view) and throw it. Or let the catcher call it. Set your infield and outfield, walk a hitter, visit the mound, warm up and bring in relievers.</li>
      <li><b>When your team is batting</b>, give a sign before each pitch: swing away, take, take until a strike, sit on the fastball, protect the plate, bunt, squeeze, steal, hit and run. Before an at-bat you can pinch-hit or pinch-run.</li>
      <li><b>Close plays at the plate</b> come to you: send the runner or hold him.</li>
      <li><b>Every manager call is graded</b> against the best option at that moment, using an exact win-probability model: <span class="grade-word green">green</span> best or as good, <span class="grade-word yellow">yellow</span> close, <span class="grade-word orange">orange</span> costly, <span class="grade-word red">red</span> a big miss. Pitch calls change what happens but aren't graded.</li>
      <li><b>The other dugout</b> is run by the computer. When your game reaches the same spot as the real one, it makes the real manager's moves.</li>
      <li><b>Afterward</b>, see what really happened, how the real manager's calls grade out, and share your result.</li>
    </ul>
    <p><b>Keyboard:</b> <span class="kbd">1</span>-<span class="kbd">6</span> pitch type, arrow keys move the target, <span class="kbd">Enter</span> throws or takes the next pitch, <span class="kbd">C</span> catcher's call.</p>
    <p><b>Modes:</b> Today's game is the same for everyone each day. Survivor strings random 9th innings together until you lose; if every call in a loss was green or yellow, you get one free pass per run. The archive has all 500.</p>
  </div>`;
}
