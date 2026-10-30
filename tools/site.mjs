// Build the public website into _site/: a full HTML page (web/index.html is the
// page body, the same file the claude.ai artifact uses), the bundled app.js and
// the scenario data.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const OUT = join(ROOT, '_site');

const DESCRIPTION = 'Manage the 9th inning of 500 real historic postseason games. Call the pitches, give the signs, run the bullpen, and see how your calls grade out against the real managers.';
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='29' fill='%23f6f3e8' stroke='%23000' stroke-width='4'/%3E%3Cpath d='M15 13c9 9 9 29 0 38M49 13c-9 9-9 29 0 38' fill='none' stroke='%23c8102e' stroke-width='3.5' stroke-dasharray='4 3'/%3E%3C/svg%3E";

export function buildSite() {
  build();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'data'), { recursive: true });
  const src = readFileSync(join(WEB, 'index.html'), 'utf8');
  const cut = src.indexOf('<div id="app">');
  if (cut < 0) throw new Error('web/index.html: missing <div id="app">');
  const headPart = src.slice(0, cut).trim();
  const bodyPart = src.slice(cut).trim();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="${DESCRIPTION}">
<meta name="theme-color" content="#000000">
<meta property="og:type" content="website">
<meta property="og:title" content="Last Licks: manage the 9th">
<meta property="og:description" content="${DESCRIPTION}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${FAVICON}">
<style>:root{color-scheme:dark;background:#000;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}[hidden]{display:none!important}</style>
${headPart}
</head>
<body>
${bodyPart}
</body>
</html>
`;
  writeFileSync(join(OUT, 'index.html'), html);
  copyFileSync(join(WEB, 'app.js'), join(OUT, 'app.js'));
  for (const f of readdirSync(join(WEB, 'data'))) {
    if (f.endsWith('.json')) copyFileSync(join(WEB, 'data', f), join(OUT, 'data', f));
  }
  writeFileSync(join(OUT, '.nojekyll'), '');
  return OUT;
}

if (process.argv[1] && process.argv[1].endsWith('site.mjs')) {
  console.log('Built', buildSite());
}
