// Bundle web/js/**/*.js ES modules into one classic script: web/app.js
// Each module runs in its own function scope; imports become lookups in a
// small registry. No dependencies.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'web', 'js');

function walk(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

function transform(path, code) {
  const id = relative(SRC, path).split('\\').join('/');
  const exportsList = [];
  code = code.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)';?[ \t]*$/gm, (m, names, from) => {
    const target = posix.normalize(posix.join(posix.dirname(id), from));
    const binds = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [a, b] = s.split(/\s+as\s+/);
      return b ? `${a}: ${b}` : a;
    });
    return `const { ${binds.join(', ')} } = __req(${JSON.stringify(target)});`;
  });
  code = code.replace(/^export\s+((?:async\s+)?function\*?)\s+([\w$]+)/gm, (m, kw, name) => { exportsList.push(name); return `${kw} ${name}`; });
  code = code.replace(/^export\s+(const|let|var|class)\s+([\w$]+)/gm, (m, kw, name) => { exportsList.push(name); return `${kw} ${name}`; });
  code = code.replace(/^export\s*\{([^}]*)\};?/gm, (m, names) => {
    for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) exportsList.push(n.split(/\s+as\s+/)[0]);
    return '';
  });
  if (/^\s*(import|export)\s/m.test(code)) throw new Error('unhandled import/export in ' + id);
  return `__def(${JSON.stringify(id)}, function (exports) {\n${code}\nObject.assign(exports, { ${[...new Set(exportsList)].join(', ')} });\n});\n`;
}

export function build() {
  const files = walk(SRC);
  let out = '// Last Licks. Built from web/js by tools/build.mjs.\n(function () {\n"use strict";\nconst __m = {};\nfunction __def(id, fn) { __m[id] = { fn, exports: null }; }\nfunction __req(id) { const m = __m[id]; if (!m) throw new Error("missing module " + id); if (!m.exports) { m.exports = {}; m.fn(m.exports); } return m.exports; }\n';
  for (const f of files) out += transform(f, readFileSync(f, 'utf8'));
  out += '__req("ui/main.js");\n})();\n';
  writeFileSync(join(ROOT, 'web', 'app.js'), out);
  return out.length;
}

if (process.argv[1] && process.argv[1].endsWith('build.mjs')) {
  const n = build();
  console.log(`web/app.js written (${Math.round(n / 1024)} KB)`);
}
