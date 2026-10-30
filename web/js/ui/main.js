// Boot and routing.
import { makeRng } from '../engine/rng.js';
import { $, esc, toast, openSheet, closeSheet, copyText, dayNumber, dailyOrder } from './util.js';
import { load, save, settings, setSetting, recordGame } from './store.js';
import { mountGame } from './play.js';
import {
  homeHtml, archiveHtml, pregameHtml, resultHtml, statsHtml, howtoHtml, shareText,
  realManagerCalls, realCallsHtml, wireChart, setNameShard,
} from './views.js';

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

function applyTheme() {
  const t = settings().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function shell(active, body) {
  const link = (h, l) => `<a href="#${h}" ${active === h ? 'aria-current="page"' : ''}>${l}</a>`;
  const t = settings().theme;
  root().innerHTML = `<header class="topbar"><div class="in">
      <a class="brand" href="#home"><b>Last Licks</b><span>Manage the ninth</span></a>
      <nav class="nav" aria-label="Main">${link('home', 'Home')}${link('daily', 'Today')}${link('survivor', 'Survivor')}${link('archive', 'Archive')}${link('stats', 'Record')}</nav>
      <button class="iconbtn" id="help" title="How to play" aria-label="How to play">?</button>
      <button class="iconbtn" id="theme" title="Theme: ${t}" aria-label="Switch theme (now ${t})">${t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐'}</button>
    </div></header><main id="main">${body}</main>`;
  $('#help').onclick = showHelp;
  $('#theme').onclick = () => {
    const next = { system: 'light', light: 'dark', dark: 'system' }[settings().theme] || 'system';
    setSetting('theme', next);
    applyTheme();
    route();
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
    if (h === 'archive') return renderArchive();
    if (h === 'stats') { shell('stats', statsHtml(app)); return; }
    if (h === 'daily') {
      const id = todayRow().id;
      return renderPregame(id, { mode: 'daily' });
    }
    if (h === 'survivor') return renderSurvivor();
    if (h.startsWith('s-')) return renderPregame(h.slice(2), { mode: 'archive' });
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

function renderArchive() {
  shell('archive', archiveHtml(app, app.filters));
  const m = $('#main');
  const upd = () => {
    app.filters = {
      q: $('#q').value, dec: $('#fdec').value, round: $('#fround').value, sit: $('#fsit').value,
      played: $('#fplayed').value, legend: $('#flegend').checked, limit: app.filters.limit,
    };
    const pos = $('#q').selectionStart;
    shell('archive', archiveHtml(app, app.filters));
    wire();
    const q = $('#q');
    if (document.activeElement !== q && app._typing) { q.focus(); q.setSelectionRange(pos, pos); }
  };
  const wire = () => {
    $('#q').addEventListener('input', () => { app._typing = true; upd(); });
    for (const id of ['#fdec', '#fround', '#fsit', '#fplayed', '#flegend']) $(id).addEventListener('change', () => { app._typing = false; upd(); });
    const more = $('#more');
    if (more) more.onclick = () => { app.filters.limit = (app.filters.limit || 120) + 120; app._typing = false; upd(); };
  };
  void m;
  wire();
}

async function renderPregame(id, opts) {
  shell(opts.mode === 'daily' ? 'daily' : opts.mode === 'survivor' ? 'survivor' : 'archive', '<div class="wrap"><div class="loading">Loading the lineup cards…</div></div>');
  const got = await getScenario(id);
  if (!got) return renderHome();
  const { sc, shard } = got;
  setNameShard(shard);
  const choice = app.pre && app.pre.id === id ? app.pre : { id, side: sc.side, start: 0, mode: opts.mode };
  choice.mode = opts.mode;
  app.pre = choice;
  const draw = () => {
    shell(opts.mode === 'daily' ? 'daily' : opts.mode === 'survivor' ? 'survivor' : 'archive', pregameHtml(app, sc, choice));
    $('#main').onclick = (e) => {
      const s = e.target.closest('[data-side]');
      if (s) { choice.side = +s.dataset.side; return draw(); }
      const st = e.target.closest('[data-start]');
      if (st) { choice.start = +st.dataset.start; return draw(); }
      if (e.target.closest('[data-go]')) startGame(sc, shard, choice);
    };
  };
  draw();
}

function startGame(sc, shard, choice) {
  const startIdx = sc.starts[choice.start] ? sc.starts[choice.start].idx : 0;
  const day = app.dayNo;
  const seed = choice.mode === 'daily' ? `daily-${day}-${sc.id}-${choice.side}-${startIdx}` : `${sc.id}-${Date.now()}`;
  shell(choice.mode === 'daily' ? 'daily' : choice.mode === 'survivor' ? 'survivor' : 'archive', '<div id="gameroot"></div>');
  const gr = document.getElementById('gameroot');
  app.game = mountGame(gr, {
    sc, shard, userSide: choice.side, startIdx, mode: choice.mode, day, seed,
    onHelp: showHelp,
    onQuit: () => { location.hash = choice.mode === 'daily' ? 'home' : 's-' + sc.id; route(); },
    onFinish: (res) => setTimeout(() => finishGame(sc, shard, choice, res), 650),
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
        extra.survivor = `Survivor: ${run.wins} straight. On to the next one.`;
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
  shell(choice.mode === 'daily' ? 'daily' : choice.mode === 'survivor' ? 'survivor' : 'archive', resultHtml(app, sc, res, extra));
  wireChart($('#main'), res.wp);
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
    if (e.target.closest('[data-again]')) startGame(sc, shard, { ...choice, mode: choice.mode === 'daily' ? 'archive' : choice.mode === 'survivor' ? 'archive' : choice.mode });
    if (e.target.closest('[data-swap]')) startGame(sc, shard, { ...choice, side: 1 - choice.side, mode: 'archive' });
    if (e.target.closest('[data-next]')) { location.hash = 'survivor'; route(); }
  };
  // grade the real manager after the page is up
  setTimeout(() => {
    const el = document.getElementById('realcalls');
    if (!el) return;
    const calls = realManagerCalls(sc, shard, choice.side);
    el.innerHTML = realCallsHtml(sc, choice.side, calls);
  }, 80);
}

async function renderSurvivor() {
  const st = load();
  if (!st.survivor.run) {
    shell('survivor', `<div class="wrap"><div class="pregame"><div class="today"><div class="lights"></div>
      <div class="eyebrow">Survivor</div><h1>One loss and you're out</h1>
      <p class="intro">Random historic 9th innings, back to back. You manage the team that's behind (or the home team in a tie), from the top of the 9th. Lose and the run is over, unless every call you made that game was green or yellow: then you get one free pass per run.</p>
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

// ---------------------------------------------------------------- boot
async function boot() {
  applyTheme();
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
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
