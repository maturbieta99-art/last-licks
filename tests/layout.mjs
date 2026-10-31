// Does the game screen fit? Loads the game in headless Chrome at real phone and
// iPad window sizes (Safari's visible area in both orientations, with and without
// the tab bar, the Home Screen app, Split View, Stage Manager windows, page zoom)
// and checks, while pitching and while batting, that the strike zone and the
// batter are fully on screen and nothing in the at-bat panel is cut off.
//   node tests/layout.mjs                       starts tools/serve.mjs on a free port
//   BASE=https://… node tests/layout.mjs        checks a deployed copy instead
//   CHROME=/path/to/chrome node tests/layout.mjs
//   SHOTS=some/folder node tests/layout.mjs     also saves a screenshot of each layout
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [
  // iPad, Safari, sideways: mini, 9th gen, Air/10th gen (+ tab bar, + Home Screen), Pro 11", Pro 13", older 9.7"
  ['iPad Air landscape', 1180, 746], ['iPad Air landscape, tab bar', 1180, 710], ['iPad Air landscape, Home Screen', 1180, 800],
  ['iPad mini landscape', 1133, 670], ['iPad 9th gen landscape', 1080, 736], ['iPad Pro 11 landscape', 1194, 760],
  ['iPad Pro 13 landscape', 1366, 950], ['iPad 9.7 landscape', 1024, 690], ['iPad landscape, tab + bookmarks bars', 1180, 700],
  // iPad, upright
  ['iPad mini portrait', 744, 1063], ['iPad 9th gen portrait', 810, 1006], ['iPad Air portrait', 820, 1106],
  ['iPad Pro 11 portrait', 834, 1120], ['iPad Pro 13 portrait', 1024, 1292],
  // Split View, Stage Manager windows, Safari page zoom (125% and 115% on an iPad Air)
  ['Split View half', 585, 746], ['Split View third', 375, 746], ['Split View two thirds portrait', 504, 1106],
  ['Stage Manager 1000x700', 1000, 700], ['Stage Manager 1100x705', 1100, 705], ['Stage Manager 900x600', 900, 600],
  ['Stage Manager 760x620', 760, 620], ['Stage Manager 980x560', 980, 560], ['iPad Air landscape at 125%', 944, 597],
  ['iPad Air landscape at 115%', 1026, 649],
  // phones and a laptop
  ['iPhone SE', 375, 553], ['iPhone', 390, 664], ['iPhone Pro Max', 430, 740], ['iPhone sideways', 844, 390],
  ['iPhone SE sideways', 667, 375], ['laptop', 1280, 800],
];
const GAMES = ['ARI200111040', 'LAN202110060'];

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const R = (e) => e.getBoundingClientRect();
  const gs = q('.gs'), p = q('.g-panel'), z = q('.g-panel .zone'), s = q('.g-panel .sil'), d = q('.g-dock');
  if (!gs || !p || !z || !s || !d) return { bad: ['game screen not found'] };
  const P = R(p), Z = R(z), S = R(s), D = R(d), e = 1;
  const V = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const inside = (a, c) => a.left >= c.left - e && a.right <= c.right + e && a.top >= c.top - e && a.bottom <= c.bottom + e;
  const bad = [];
  if (!inside(Z, P) || !inside(Z, V)) bad.push('strike zone cut off');
  if (!inside(S, P) || !inside(S, V)) bad.push('batter cut off');
  if (p.scrollWidth > p.clientWidth + e) bad.push('panel content ' + (p.scrollWidth - p.clientWidth) + 'px too wide');
  if (p.scrollHeight > p.clientHeight + e) bad.push('panel content ' + (p.scrollHeight - p.clientHeight) + 'px too tall');
  const bs = q('.g-board .board-scroll');
  if (bs && bs.offsetParent && bs.scrollWidth > bs.clientWidth + e) bad.push('line score cut off');
  if (D.bottom > innerHeight + e || D.right > innerWidth + e) bad.push('buttons off screen');
  if (document.documentElement.scrollHeight > innerHeight + e) bad.push('page scrolls');
  const cell = (Z.height - 22) / 5;
  if (cell < 20) bad.push('zone cells only ' + cell.toFixed(1) + 'px');
  return { bad, cell: Math.round(cell), mode: q('[data-act="bat"]') ? 'batting' : q('[data-act="pitch"]') ? 'pitching' : '?' };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));
const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const chrome = CHROMES.find((c) => c && existsSync(c));
if (!chrome) { console.log('SKIP: Chrome not found (set CHROME to its path)'); process.exit(0); }

const kids = [];
const profile = mkdtempSync(join(tmpdir(), 'll-layout-'));
const cleanup = () => { for (const k of kids) { try { k.kill(); } catch { /* gone */ } } try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ } };

async function waitFor(fn, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } }
  throw new Error('timed out');
}

let base = process.env.BASE;
if (!base) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  kids.push(spawn(process.execPath, [join(HERE, '..', 'tools', 'serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' }));
  base = `http://localhost:${port}/`;
  await waitFor(async () => (await fetch(base)).ok);
}

const dport = 9000 + Math.floor(Math.random() * 900);
kids.push(spawn(chrome, ['--headless=new', `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' }));
const wsUrl = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl);
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nid = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); if (d.error) p.rej(new Error(d.error.message)); else p.res(d.result); }
  else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const resize = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
};
await send('Runtime.enable');
await send('Page.enable');

let fails = 0, checks = 0;
try {
  for (const id of GAMES) {
    for (const side of [1, 0]) {
      // a fresh load at the first size, then turn and resize the same game through the rest
      const [, w0, h0] = SIZES[0];
      await resize(w0, h0);
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(200);
      await send('Page.navigate', { url: `${base}#s-${id}` });
      await waitFor(() => evaluate(`!!document.querySelector('[data-go]')`));
      await evaluate(`document.querySelector('[data-side="${side}"]').click()`);
      await evaluate(`document.querySelector('[data-go]').click()`);
      await waitFor(() => evaluate(`!!document.querySelector('.gs .g-panel .zone')`));
      await evaluate(`document.fonts.ready.then(() => true)`);
      await sleep(400);
      await evaluate(`(() => { const c = document.querySelector('.coldopen'); if (c) c.click(); return true; })()`);
      for (const [name, w, h] of SIZES) {
        await resize(w, h);
        await sleep(250);
        const m = await evaluate(MEASURE);
        checks++;
        if (m.bad.length) { fails++; console.log(`FAIL ${id} ${m.mode} @ ${name} ${w}x${h}: ${m.bad.join('; ')}`); }
        if (process.env.SHOTS) {
          mkdirSync(process.env.SHOTS, { recursive: true });
          const { data } = await send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join(process.env.SHOTS, `${id}-${m.mode}-${w}x${h}.png`), Buffer.from(data, 'base64'));
        }
      }
    }
  }
} finally {
  ws.close();
  cleanup();
}
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
console.log(`${checks - fails}/${checks} layouts fit${fails || errors.length ? '' : ' - PASS'}`);
process.exit(fails || errors.length ? 1 : 0);
