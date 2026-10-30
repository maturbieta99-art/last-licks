// Ballpark sounds synthesized with WebAudio: no audio files. Nothing plays
// until the player has clicked something (browsers require a gesture), and the
// whole thing is off when muted.
import { settings, setSetting } from './store.js';

let ctx = null;
let master = null;
let crowd = null;

function audio() {
  if (!settings().sound) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export const soundOn = () => !!settings().sound;
export function toggleSound() {
  const on = !settings().sound;
  setSetting('sound', on);
  if (!on) stopCrowd();
  else audio();
  return on;
}
// call from any click handler: unlocks audio on browsers that need a gesture
export function unlock() { if (settings().sound) audio(); }

function noiseBuffer(ac, seconds, color = 'white') {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}

function burst(ac, { t = 0, dur = 0.08, type = 'bandpass', freq = 1500, q = 1, gain = 0.6, attack = 0.002 }) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur + 0.05);
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  const t0 = ac.currentTime + t;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

function tone(ac, { t = 0, freq = 440, to = null, dur = 0.2, type = 'sine', gain = 0.2, attack = 0.005 }) {
  const o = ac.createOscillator();
  o.type = type;
  const t0 = ac.currentTime + t;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

// the catcher's mitt
export function pop(strength = 1) {
  const ac = audio(); if (!ac) return;
  burst(ac, { dur: 0.06, freq: 1800, q: 0.9, gain: 0.5 * strength });
  tone(ac, { freq: 180, to: 90, dur: 0.09, gain: 0.35 * strength });
}
// wood on leather; harder contact is louder and brighter
export function crack(hard = false) {
  const ac = audio(); if (!ac) return;
  burst(ac, { dur: hard ? 0.12 : 0.08, type: 'highpass', freq: hard ? 1800 : 1200, q: 0.7, gain: hard ? 0.9 : 0.6 });
  tone(ac, { freq: hard ? 2600 : 2100, to: 900, dur: 0.05, type: 'triangle', gain: 0.25 });
  tone(ac, { freq: 140, to: 70, dur: 0.07, gain: 0.3 });
}
// the crowd reacts: +1 cheer, -1 groan, size 0..1
export function crowdReact(sign, size = 0.5) {
  const ac = audio(); if (!ac) return;
  const dur = 0.9 + size * 1.6;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur + 0.1, 'brown');
  const f = ac.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = 0.6;
  const t0 = ac.currentTime;
  if (sign > 0) { f.frequency.setValueAtTime(500, t0); f.frequency.linearRampToValueAtTime(900 + 500 * size, t0 + 0.25); }
  else { f.frequency.setValueAtTime(700, t0); f.frequency.exponentialRampToValueAtTime(260, t0 + dur); }
  const g = ac.createGain();
  const peak = (sign > 0 ? 0.35 : 0.22) + 0.45 * size;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + (sign > 0 ? 0.12 : 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.1);
}
// the ballpark organ: "Charge!"
export function charge() {
  const ac = audio(); if (!ac) return;
  const notes = [[392, 0], [523, 0.13], [659, 0.26], [784, 0.39], [659, 0.62], [784, 0.75]];
  for (const [f, t] of notes) {
    const d = t >= 0.75 ? 0.5 : 0.12;
    tone(ac, { t, freq: f, dur: d, type: 'square', gain: 0.06 });
    tone(ac, { t, freq: f * 2, dur: d, type: 'sine', gain: 0.05 });
  }
}
// a low organ sting for the end of a game
export function sting(won) {
  const ac = audio(); if (!ac) return;
  const chord = won ? [523, 659, 784, 1047] : [220, 262, 311];
  for (const f of chord) tone(ac, { freq: f, dur: won ? 1.2 : 1.0, type: 'triangle', gain: 0.07, attack: 0.03 });
}

// A steady crowd murmur under the game; louder when the pressure is up.
export function setCrowd(level) {
  const ac = audio();
  if (!ac) return;
  if (!crowd) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac, 4, 'brown');
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 650;
    const g = ac.createGain();
    g.gain.value = 0.0001;
    src.connect(f); f.connect(g); g.connect(master);
    src.start();
    crowd = { src, g, f };
  }
  const v = 0.03 + 0.14 * Math.max(0, Math.min(1, level));
  crowd.g.gain.setTargetAtTime(v, ac.currentTime, 0.6);
  crowd.f.frequency.setTargetAtTime(550 + 500 * level, ac.currentTime, 0.6);
}
export function stopCrowd() {
  if (!crowd || !ctx) return;
  try { crowd.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2); crowd.src.stop(ctx.currentTime + 0.8); } catch { /* already stopped */ }
  crowd = null;
}
