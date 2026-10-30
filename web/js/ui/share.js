// A picture of a finished game for sharing, drawn on a canvas in the game's
// own look (no image files), plus the share sheet with a text fallback.
import { copyText } from './util.js';

const GRADE = { green: ['#3ad07e', 'A'], yellow: ['#ffd23f', 'B'], orange: ['#ff8c32', 'C'], red: ['#ff4f5e', 'F'] };

function wrap(ctx, text, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// card: { event, title, team, won, score: [mine, theirs], grades: [...], stars: [0|1 x3], color, url }
export async function resultCard(card) {
  try {
    await Promise.all(['800 80px Fraunces', 'italic 800 60px Fraunces', '900 150px Doto', '800 28px "Libre Franklin"'].map((f) => document.fonts.load(f)));
  } catch { /* fallback fonts are fine */ }
  const W = 1080, H = 1080;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W / 2, -80, 40, W / 2, -80, 900);
  glow.addColorStop(0, 'rgba(255,241,207,.28)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);
  const grass = c.createRadialGradient(W / 2, H + 260, 60, W / 2, H + 260, 700);
  grass.addColorStop(0, 'rgba(46,110,59,.55)');
  grass.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = grass;
  c.fillRect(0, 0, W, H);
  // brand
  c.fillStyle = '#f2efe6';
  c.font = 'italic 800 60px Fraunces, Georgia, serif';
  c.fillText('Last Licks', 80, 140);
  c.fillStyle = '#9a958b';
  c.font = '800 26px "Libre Franklin", Arial, sans-serif';
  c.fillText('MANAGE THE NINTH', 80, 182);
  // the game
  c.fillStyle = '#9a958b';
  c.font = '800 28px "Libre Franklin", Arial, sans-serif';
  c.fillText(String(card.event).toUpperCase(), 80, 290);
  c.fillStyle = '#f2efe6';
  c.font = '800 80px Fraunces, Georgia, serif';
  let y = 380;
  for (const line of wrap(c, card.title, W - 160).slice(0, 2)) { c.fillText(line, 80, y); y += 92; }
  // the result, in bulbs
  c.font = '900 150px Doto, monospace';
  c.shadowColor = 'rgba(255,222,160,.75)';
  c.shadowBlur = 30;
  c.fillStyle = '#fff1cf';
  c.fillText(`${card.won ? 'WON' : 'LOST'} ${card.score[0]}-${card.score[1]}`, 72, y + 150);
  c.shadowBlur = 0;
  c.fillStyle = '#9a958b';
  c.font = '700 30px "Libre Franklin", Arial, sans-serif';
  c.fillText(`Managing the ${card.team}`, 80, y + 205);
  // grades
  let x = 80;
  const gy = y + 260;
  for (const gr of card.grades.slice(0, 12)) {
    const [col, letter] = GRADE[gr];
    c.fillStyle = col;
    c.beginPath();
    c.roundRect ? c.roundRect(x, gy, 62, 62, 12) : c.rect(x, gy, 62, 62);
    c.fill();
    c.fillStyle = '#000';
    c.font = '900 34px "Libre Franklin", Arial, sans-serif';
    c.textAlign = 'center';
    c.fillText(letter, x + 31, gy + 44);
    c.textAlign = 'left';
    x += 74;
  }
  // stars
  c.font = '48px Arial, sans-serif';
  card.stars.forEach((on, i) => {
    c.fillStyle = on ? '#fff1cf' : '#3a3833';
    c.shadowColor = on ? 'rgba(255,222,160,.8)' : 'transparent';
    c.shadowBlur = on ? 18 : 0;
    c.fillText('★', 80 + i * 60, gy + 150);
  });
  c.shadowBlur = 0;
  // footer
  c.fillStyle = card.color || '#fff1cf';
  c.fillRect(80, H - 120, 6, 44);
  c.fillStyle = '#f2efe6';
  c.font = '700 30px "Libre Franklin", Arial, sans-serif';
  c.fillText('Can you manage it better?', 104, H - 92);
  c.fillStyle = '#9a958b';
  c.font = '600 24px "Libre Franklin", Arial, sans-serif';
  c.fillText(card.url.replace(/^https?:\/\//, ''), 104, H - 60);
  return new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
}

// Share sheet with the picture where the device supports it, else the text.
export async function shareResult({ text, url, blob }) {
  try {
    if (blob && navigator.canShare) {
      const file = new File([blob], 'last-licks.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: `${text}\n${url}` });
        return 'shared';
      }
    }
    if (navigator.share) {
      await navigator.share({ text, url });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
  }
  return (await copyText(`${text}\n${url}`)) ? 'copied' : 'failed';
}
