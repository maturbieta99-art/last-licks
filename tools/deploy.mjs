// Publish the website: build _site/ and push it to the gh-pages branch of this
// repo's GitHub remote. GitHub Pages serves that branch.
//   node tools/deploy.mjs
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from './site.mjs';

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const remote = run('git remote get-url origin');
const name = run('git config user.name');
const email = run('git config user.email');
const out = buildSite();
rmSync(join(out, '.git'), { recursive: true, force: true });
run('git init -q -b gh-pages', out);
run('git add -A', out);
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
run(`git -c user.name="${name}" -c user.email="${email}" commit -q -m "Deploy ${stamp}"`, out);
// authenticate with the GitHub CLI login for this push only
run(`git -c credential.helper= -c "credential.helper=!gh auth git-credential" push -q -f ${remote} gh-pages`, out);
rmSync(join(out, '.git'), { recursive: true, force: true });
console.log(`Pushed the site to ${remote} (gh-pages).`);
