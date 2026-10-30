// Small DOM and formatting helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
export const avg3 = (x) => (x >= 1 ? x.toFixed(3) : x.toFixed(3).replace(/^0/, ''));

export function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd);
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function toast(msg, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

export function openSheet(title, bodyHtml, onMount, opts = {}) {
  closeSheet();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.id = 'sheet';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2>${opts.locked ? '' : '<button class="btn small" data-close>Close</button>'}</header>
    <div class="body">${bodyHtml}</div></div>`;
  scrim.addEventListener('click', (e) => {
    if (!opts.locked && (e.target === scrim || e.target.closest('[data-close]'))) closeSheet();
  });
  document.body.appendChild(scrim);
  const first = scrim.querySelector('button:not([data-close]), [tabindex]');
  if (first) first.focus();
  if (onMount) onMount(scrim);
  return scrim;
}
export function closeSheet() {
  const s = document.getElementById('sheet');
  if (s) s.remove();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Daily schedule: day 1 is the launch date; legends and the rest interleave.
export const LAUNCH = new Date(2026, 9, 29);
export function dayNumber(d = new Date()) {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((a - LAUNCH) / 86400000) + 1;
}
export function dailyOrder(index, shuffle) {
  const legends = index.filter((r) => r.legend);
  const rest = index.filter((r) => !r.legend);
  const L = [legends[0], ...shuffle(legends.slice(1), 'daily-legends')];
  const R = shuffle(rest, 'daily-rest');
  const out = [];
  let li = 0, ri = 0;
  while (out.length < index.length) {
    if (out.length % 3 === 0 && li < L.length) out.push(L[li++]);
    else if (ri < R.length) out.push(R[ri++]);
    else out.push(L[li++]);
  }
  return out;
}
