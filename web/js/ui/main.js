// Boot and routing.
import { makeRng } from '../engine/rng.js';
import { $, esc, toast, openSheet, closeSheet, copyText, dayNumber, dailyOrder } from './util.js';
import { load, save, recordGame, recordStars, exportCode, importCode } from './store.js';
import { PASS, canPlay, redeem, recheck, forget, member } from './pass.js';
import { resultCard, shareResult } from './share.js';
import { teamColors } from './teams.js';
import { mountGame } from './play.js';
import { soundOn, toggleSound, unlock } from './sound.js';
import {
  homeHtml, archiveHtml, pregameHtml, resultHtml, statsHtml, howtoHtml, shareText,
  realManagerCalls, realCallsHtml, wireChart, setNameShard, starsFor, starsHtml, collectionRows, passHtml, FIRST_GAME,
} from './views.js';

const LETTER = { green: 'A', yellow: 'B', orange: 'C', red: 'F' };
const FROM_LETTER = { A: 'green', B: 'yellow', C: 'orange', F: 'red' };
const gateCtx = () => ({ firstGame: FIRST_GAME, day: app.dayNo });

const app = { index: [], shards: {}, game: null, filters: { limit: 120 }, pre: null };
const root = () => document.getElementById('app');

function shuffle(arr, seed) {
  const rng = makeRng(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getShard(file) {
  if (!app.shards[file]) {
    const res = await fetch('data/' + file);
    if (!res.ok) throw new Error('Could not load ' + file);
    app.shards[file] = await res.json();
  }
  return app.shards[file];
}
async function getScenario(id) {
  const row = app.index.find((r) => r.id === id);
  if (!row) return null;
  const shard = await getShard(row.shard);
  return { row, sc: shard.scenarios[id], shard };
}

const MARK = `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="#f2efe6"/><path d="M14 14c9 9 9 27 0 36M50 14c-9 9-9 27 0 36" fill="none" stroke="#c8102e" stroke-width="3.2" stroke-dasharray="4 3"/></svg>`;
const SPEAKER = (on) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${on ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' : '<path d="M16.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'}</svg>`;

function shell(active, body) {
  const link = (h, l) => `<a href="#${h}" ${active === h ? 'aria-current="page"' : ''}>${l}</a>`;
  const on = soundOn();
  root().innerHTML = `<header class="topbar"><div class="in">
      <a class="brand" href="#home">${MARK}<b>Last Licks</b><span>Manage the ninth</span></a>
      <nav class="nav" aria-label="Main">${link('daily', 'Today')}${link('survivor', 'Win or Go Home')}${link('archive', 'Archive')}${link('stats', 'Record')}</nav>
      <div class="tb-tools">
        <button class="iconbtn" id="snd" aria-pressed="${on}" title="Sound ${on ? 'on' : 'off'}" aria-label="Sound ${on ? 'on' : 'off'}">${SPEAKER(on)}</button>
        <button class="iconbtn" id="help" title="How to play" aria-label="How to play">?</button>
      </div>
    </div></header><main id="main">${body}</main>`;
  $('#help').onclick = showHelp;
  $('#snd').onclick = () => {
    const now = toggleSound();
    const b = $('#snd');
    b.setAttribute('aria-pressed', now);
    b.title = `Sound ${now ? 'on' : 'off'}`;
    b.setAttribute('aria-label', b.title);
    b.innerHTML = SPEAKER(now);
    toast(now ? 'Sound on.' : 'Sound off.');
  };
}
function showHelp() { openSheet('How to play', howtoHtml()); }

// ---------------------------------------------------------------- routes
async function route() {
  if (app.game && app.game.destroy) { app.game.destroy(); app.game = null; }
  closeSheet();
  const h = (location.hash || '#home').slice(1);
  try {
    if (h === 'home' || h === '') return renderHome();
    const locked = PASS.on && !member();
    if (h === 'pass') return renderPass();
    if (h.startsWith('c-')) return renderChallenge(h.slice(2));
    if (h === 'archive') return locked ? renderPass() : renderArchive();
    if (h.startsWith('list-')) { if (locked) return renderPass(); app.filters = { limit: 120, coll: h.slice(5) }; return renderArchive(); }
    if (h.startsWith('rand-')) return locked ? renderPass() : randomFrom(h.slice(5));
    if (h === 'stats') { shell('stats', statsHtml(app)); wireStats(); return; }
    if (h === 'daily') {
      const id = todayRow().id;
      if (!canPlay('daily', id, gateCtx())) return renderPass("You've played today's game. Come back tomorrow for a new one, or get the Season Pass to replay it and play any of the 500.");
      return renderPregame(id, { mode: 'daily' });
    }
    if (h === 'survivor') return renderSurvivor();
    if (h.startsWith('s-')) {
      const id = h.slice(2);
      if (!canPlay('archive', id, gateCtx())) return renderPass();
      return renderPregame(id, { mode: 'archive' });
    }
    return renderHome();
  } catch (e) {
    console.error(e);
    shell('', `<div class="wrap"><div class="loading">Something went wrong loading that page. ${esc(e.message)}</div></div>`);
  }
}

function todayRow() {
  const order = dailyOrder(app.index, shuffle);
  const n = app.dayNo;
  return order[((n - 1) % order.length + order.length) % order.length];
}

function renderHome() {
  app.today = todayRow();
  shell('home', homeHtml(app));
}

// a random game from a playlist, preferring ones not played yet
function randomFrom(key) {
  const rows = collectionRows(app, key);
  if (!rows.length) { location.hash = 'archive'; return; }
  const st = load();
  const fresh = rows.filter((r) => !st.played[r.id]);
  const pool = fresh.length ? fresh : rows;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  history.replaceState(null, '', '#s-' + pick.id);
  return renderPregame(pick.id, { mode: 'archive' });
}

function renderArchive() {
  shell('archive', archiveHtml(app, app.filters));
  const upd = () => {
    app.filters = {
      q: $('#q').value, dec: $('#fdec').value, round: $('#fround').value, sit: $('#fsit').value,
      played: $('#fplayed').value, legend: $('#flegend').checked, limit: app.filters.limit, coll: $('#fcoll').value,
    };
    const pos = $('#q').selectionStart;
    shell('archive', archiveHtml(app, app.filters));
    wire();
    const q = $('#q');
    if (document.activeElement !== q && app._typing) { q.focus(); q.setSelectionRange(pos, pos); }
  };
  const wire = () => {
    $('#q').addEventListener('input', () => { app._typing = true; upd(); });
    for (const id of ['#fdec', '#fround', '#fsit', '#fplayed', '#flegend', '#fcoll']) $(id).addEventListener('change', () => { app._typing = false; upd(); });
    const more = $('#more');
    if (more) more.onclick = () => { app.filters.limit = (app.filters.limit || 120) + 120; app._typing = false; upd(); };
  };
  wire();
}

async function renderPregame(id, opts) {
  const tab = opts.mode === 'daily' ? 'daily' : opts.mode === 'survivor' ? 'survivor' : 'archive';
  shell(tab, '<div class="wrap"><div class="loading">Loading the lineup cards…</div></div>');
  const got = await getScenario(id);
  if (!got) return renderHome();
  const { sc, shard } = got;
  setNameShard(shard);
  const choice = app.pre && app.pre.id === id ? app.pre : { id, side: sc.side, start: 0, mode: opts.mode };
  choice.mode = opts.mode;
  app.pre = choice;
  const draw = () => {
    shell(tab, pregameHtml(app, sc, choice));
    $('#main').onclick = (e) => {
      const s = e.target.closest('[data-side]');
      if (s) { choice.side = +s.dataset.side; return draw(); }
      const st = e.target.closest('[data-start]');
      if (st) { choice.start = +st.dataset.start; return draw(); }
      if (e.target.closest('[data-go]')) { unlock(); startGame(sc, shard, choice); }
    };
  };
  draw();
}

function startGame(sc, shard, choice) {
  const startIdx = sc.starts[choice.start] ? sc.starts[choice.start].idx : 0;
  const day = app.dayNo;
  const seed = choice.seed || (choice.mode === 'daily' ? `daily-${day}-${sc.id}-${choice.side}-${startIdx}` : `${sc.id}-${Date.now().toString(36)}`);
  shell(choice.mode === 'daily' ? 'daily' : choice.mode === 'survivor' ? 'survivor' : 'archive', '<div id="gameroot"></div>');
  const gr = document.getElementById('gameroot');
  app.game = mountGame(gr, {
    sc, shard, userSide: choice.side, startIdx, mode: choice.mode, day, seed,
    onHelp: showHelp,
    onQuit: () => { location.hash = choice.mode === 'daily' ? 'home' : 's-' + sc.id; route(); },
    onFinish: (res) => finishGame(sc, shard, choice, res),
  });
  window.scrollTo({ top: 0 });
}

function finishGame(sc, shard, choice, res) {
  recordGame(res);
  const extra = {};
  const st = load();
  if (choice.mode === 'survivor') {
    const run = st.survivor.run;
    if (run) {
      const sound = res.grades.length > 0 && res.grades.every((g) => g === 'green' || g === 'yellow');
      if (res.won) {
        run.wins++; run.idx++;
        st.survivor.best = Math.max(st.survivor.best, run.wins);
        extra.survivor = `Win or Go Home: ${run.wins} straight. On to the next one.`;
        extra.next = 'Next game';
      } else if (sound && !run.passUsed) {
        run.passUsed = true; run.idx++;
        extra.survivor = 'Tough break: every call was sound, so you get your one free pass. The run lives.';
        extra.next = 'Next game';
      } else {
        extra.survivor = `Run over after ${run.wins} ${run.wins === 1 ? 'win' : 'wins'}.${run.wins >= st.survivor.best && run.wins > 0 ? ' A new best.' : ''}`;
        st.survivor.best = Math.max(st.survivor.best, run.wins);
        st.survivor.run = null;
        extra.next = 'Start a new run';
      }
      save();
    }
  }
  if (choice.challenge) extra.challenge = choice.challenge;
  // two stars are known now; the third waits for the real manager's grades
  extra.stars = starsFor(res, null);
  recordStars(sc.id, extra.stars);
  shell(choice.mode === 'daily' ? 'daily' : choice.mode === 'survivor' ? 'survivor' : 'archive', resultHtml(app, sc, res, extra));
  wireChart($('#main'), res.wp);
  window.scrollTo({ top: 0 });
  $('#main').onclick = async (e) => {
    if (e.target.closest('[data-copy]')) {
      const ok = await copyText(shareText(app, sc, res));
      if (ok) toast('Copied. Paste it anywhere.');
      else {
        const r = document.createRange();
        r.selectNodeContents($('#share'));
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        toast('Selected. Copy it with your keyboard.');
      }
    }
    const replay = (opts) => {
      if (!canPlay('archive', sc.id, gateCtx())) { location.hash = 'pass'; return; }
      startGame(sc, shard, opts);
    };
    if (e.target.closest('[data-again]')) replay({ ...choice, seed: null, challenge: null, mode: 'archive' });
    if (e.target.closest('[data-swap]')) replay({ ...choice, seed: null, challenge: null, side: 1 - choice.side, mode: 'archive' });
    if (e.target.closest('[data-sharecard]')) {
      const btn = e.target.closest('[data-sharecard]');
      btn.disabled = true;
      const blob = await resultCard({ event: sc.event, title: sc.title, team: sc.teams[res.side].nick, won: res.won, score: [res.score[res.side], res.score[1 - res.side]], grades: res.grades, stars: extra.stars || [0, 0, 0], color: teamColors(sc.teams[0].code, sc.teams[1].code)[res.side], url: siteUrl() });
      const r = await shareResult({ text: shareText(app, sc, res), url: challengeUrl(sc, res), blob });
      btn.disabled = false;
      if (r === 'copied') toast('Copied. Paste it anywhere.');
      if (r === 'failed') toast('Sharing is not available here. Copy the text instead.');
    }
    if (e.target.closest('[data-challenge]')) {
      const url = challengeUrl(sc, res);
      const r = await shareResult({ text: `I managed ${sc.title} (${sc.event}) and ${res.won ? 'won' : 'lost'} ${res.score[res.side]}-${res.score[1 - res.side]}. Same game, same luck. Can you manage it better?`, url });
      if (r === 'copied') toast('Challenge link copied. Send it to a friend.');
      if (r === 'failed') toast(url);
    }
    if (e.target.closest('[data-next]')) { location.hash = 'survivor'; route(); }
  };
  // grade the real manager after the page is up, then settle the third star
  setTimeout(() => {
    const el = document.getElementById('realcalls');
    if (!el) return;
    const calls = realManagerCalls(sc, shard, choice.side);
    el.innerHTML = realCallsHtml(sc, choice.side, calls, res);
    const stars = recordStars(sc.id, starsFor(res, calls));
    const now = starsFor(res, calls);
    const box = document.getElementById('starrow');
    if (box) box.outerHTML = starsHtml(now, sc, choice.side, stars);
  }, 80);
}

async function renderSurvivor() {
  const st = load();
  if (!st.survivor.run) {
    shell('survivor', `<div class="wrap"><div class="pregame"><div class="today"><div class="lights"></div>
      <div class="eyebrow">Win or Go Home</div><h1>One loss and you're out</h1>
      <p class="intro">Historic 9th innings, back to back. You manage the team that's behind (or the home team in a tie), from the top of the 9th. Lose and the run is over, unless every call you made that game graded A or B: then you get one free pass per run.</p>
      <div class="actions"><button class="btn primary" id="go">Start a run</button></div></div>
      <div class="card panel"><h3>Best run</h3><p class="prompt-big num">${st.survivor.best}</p><p class="muted">Saved in this browser.</p></div></div></div>`);
    $('#go').onclick = () => {
      const seed = 'surv-' + Date.now();
      st.survivor.run = { seed, order: shuffle(app.index.map((r) => r.id), seed).slice(0, 500), idx: 0, wins: 0, passUsed: false };
      save();
      renderSurvivor();
    };
    return;
  }
  const run = st.survivor.run;
  const id = run.order[run.idx % run.order.length];
  app.pre = null;
  const got = await getScenario(id);
  app.pre = { id, side: got.sc.side, start: 0, mode: 'survivor' };
  return renderPregame(id, { mode: 'survivor' });
}

// ---------------------------------------------------------------- season pass, challenges, save codes
function siteUrl() { return location.origin + location.pathname; }
function challengeUrl(sc, res) {
  const grades = res.grades.map((x) => LETTER[x]).join('');
  const score = `${res.won ? 'W' : 'L'}${res.score[res.side]}-${res.score[1 - res.side]}`;
  return `${siteUrl()}#c-${[sc.id, res.side, res.start || 0, res.seed, grades || '0', score].join('~')}`;
}

async function renderChallenge(code) {
  const [id, side, start, seed, grades, score] = code.split('~');
  const got = id ? await getScenario(id) : null;
  if (!got || !seed) return renderHome();
  const { sc, shard } = got;
  setNameShard(shard);
  const si = Math.max(0, sc.starts.findIndex((st) => st.idx === +start));
  const challenge = { won: /^W/.test(score || ''), score: String(score || '').slice(1), grades: String(grades || '').split('').map((c) => FROM_LETTER[c]).filter(Boolean) };
  const choice = { id, side: +side === 1 ? 1 : 0, start: si, mode: 'challenge', seed, challenge };
  app.pre = choice;
  shell('archive', pregameHtml(app, sc, choice));
  $('#main').onclick = (e) => { if (e.target.closest('[data-go]')) { unlock(); startGame(sc, shard, choice); } };
}

function renderPass(note) {
  shell('archive', passHtml(app));
  if (note) {
    const intro = document.querySelector('.today .intro');
    if (intro) intro.textContent = note;
  }
  const btn = document.getElementById('redeem');
  if (btn) {
    btn.onclick = async () => {
      const msg = document.getElementById('passmsg');
      btn.disabled = true;
      msg.textContent = 'Checking…';
      const r = await redeem(document.getElementById('passkey').value);
      btn.disabled = false;
      if (r.ok) { toast('Season Pass unlocked. Enjoy the archive.'); location.hash = 'archive'; route(); } else msg.textContent = r.why;
    };
  }
}

function wireStats() {
  const sc = document.getElementById('savecode');
  if (sc) {
    sc.onclick = async () => {
      const code = exportCode();
      if (await copyText(code)) toast('Save code copied. Keep it somewhere safe.');
      else { const t = document.getElementById('restore'); t.value = code; t.select(); toast('Select and copy the code in the box.'); }
    };
  }
  const rb = document.getElementById('restorebtn');
  if (rb) {
    rb.onclick = () => {
      if (importCode(document.getElementById('restore').value)) { toast('Record restored.'); route(); } else toast('That save code did not work. Copy the whole code and try again.');
    };
  }
  const fp = document.getElementById('forgetpass');
  if (fp) fp.onclick = () => { forget(); toast('Season Pass removed from this device.'); route(); };
}

// ---------------------------------------------------------------- boot
async function boot() {
  app.dayNo = dayNumber();
  try {
    const res = await fetch('data/index.json');
    app.index = await res.json();
  } catch (e) {
    root().innerHTML = `<div class="wrap"><div class="loading">Couldn't load the scenario list. Reload the page to try again.</div></div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  recheck();
  if ('serviceWorker' in navigator && location.protocol === 'https:' && /github\.io|pages\.dev/.test(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
