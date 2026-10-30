// Season Pass: $4.99 a month unlocks the archive. Free players get today's
// game (once a day), Win or Go Home, the first game and challenge links.
// Payments go through Lemon Squeezy, which emails the buyer a license key.
// The site has no server, so the key is checked with Lemon Squeezy's license
// API from the browser and remembered on this device: an honor-system gate,
// since the game data itself is public.
import { load, save } from './store.js';

export const PASS = {
  on: false, // switch on once the checkout link below works
  price: '$4.99',
  per: 'month', // '' for a one-time price
  checkout: '', // Lemon Squeezy checkout link for the Season Pass product
  storeId: 0, // only keys from this store and product count (0 = don't check)
  productId: 0,
  recheckDays: 3,
};

export const passOn = () => PASS.on;
export function member() {
  const p = load().pass;
  return !!(p && p.ok);
}
export const priceText = () => `${PASS.price}${PASS.per ? ` a ${PASS.per}` : ''}`;

// Free for everyone: today's game until it has been played, Win or Go Home,
// the hand-picked first game and challenge links from a friend.
export function canPlay(mode, id, ctx) {
  if (!PASS.on || member()) return true;
  if (mode === 'survivor' || mode === 'challenge') return true;
  if (id === ctx.firstGame) return true;
  if (mode === 'daily') return !load().daily[ctx.day];
  return false;
}

async function check(key) {
  const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ license_key: key }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  const st = j.license_key && j.license_key.status;
  const meta = j.meta || {};
  if (PASS.storeId && meta.store_id !== PASS.storeId) return { ok: false, why: 'That key is for a different product.' };
  if (PASS.productId && meta.product_id !== PASS.productId) return { ok: false, why: 'That key is for a different product.' };
  if (!j.valid && st !== 'inactive') return { ok: false, why: st === 'expired' ? 'That Season Pass has ended. Renew it to keep playing the archive.' : 'That key wasn\'t recognized. Check it against your receipt email.' };
  if (st === 'expired' || st === 'disabled') return { ok: false, why: 'That Season Pass has ended. Renew it to keep playing the archive.' };
  return { ok: true, email: meta.customer_email || '' };
}

export async function redeem(key) {
  key = String(key || '').trim();
  if (!key) return { ok: false, why: 'Paste the license key from your receipt email.' };
  try {
    const r = await check(key);
    if (r.ok) {
      load().pass = { key, ok: true, checked: Date.now(), email: r.email };
      save();
    }
    return r;
  } catch {
    return { ok: false, why: 'Couldn\'t reach the payment service. Check your connection and try again.' };
  }
}

// Every few days, make sure the pass is still active. Offline: keep it.
export async function recheck() {
  const p = load().pass;
  if (!PASS.on || !p || !p.key || Date.now() - (p.checked || 0) < PASS.recheckDays * 86400000) return;
  try {
    const r = await check(p.key);
    p.ok = r.ok;
    p.checked = Date.now();
    save();
  } catch { /* offline: try again next time */ }
}

export function forget() {
  delete load().pass;
  save();
}
