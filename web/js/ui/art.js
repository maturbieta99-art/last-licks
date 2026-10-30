// Small SVG figures drawn in code (no image files).

// Batter in his stance, seen from behind the catcher. A right-handed hitter
// stands on the left side of the plate facing it; lefties are mirrored. Lit
// from behind by the floodlights, so the body is dark with a chalk rim.
export function batterSilhouette(side, color) {
  const flip = side === 'L' ? ' transform="translate(120 0) scale(-1 1)"' : '';
  return `<svg class="batter-svg" viewBox="0 0 120 220" aria-hidden="true">
    <g${flip}>
      <g fill="${color}" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">
        <path d="M48 47 L53 42 L27 3 L19 8 Z" stroke-width="1"/>
        <path d="M60 58 L50 45" stroke-width="9" fill="none"/>
        <path d="M77 58 Q66 52 50 45" stroke-width="9" fill="none"/>
        <path d="M55 52 Q66 45 79 52 L85 98 Q70 108 52 101 Z" stroke-width="2"/>
        <path d="M59 99 L46 146 L41 199" stroke-width="13" fill="none"/>
        <path d="M76 99 L89 146 L97 199" stroke-width="13" fill="none"/>
        <ellipse cx="38" cy="203" rx="11" ry="5" stroke-width="0"/>
        <ellipse cx="102" cy="203" rx="11" ry="5" stroke-width="0"/>
        <circle cx="67" cy="34" r="13" stroke-width="0"/>
        <path d="M74 27 Q86 29 90 37 L74 37 Z" stroke-width="0"/>
      </g>
      <g fill="none" stroke="var(--chalk)" stroke-opacity=".55" stroke-width="1.3" stroke-linecap="round">
        <path d="M58 22 Q66 19 75 24"/>
        <path d="M80 52 L86 98"/>
        <path d="M90 147 L98 199"/>
        <path d="M27 3 L19 8"/>
      </g>
    </g>
  </svg>`;
}

// Speed on the 20-80 scale: two bolts for the fastest 5% of hitters, one bolt
// for the top 17%, a "slow" tag for the slowest fifth.
export function speedLabel(spd) {
  if (spd >= 70) return { word: 'Burner', bolts: 2 };
  if (spd >= 60) return { word: 'Fast', bolts: 1 };
  if (spd < 42) return { word: 'Slow', bolts: 0, slow: true };
  return { word: 'Average', bolts: 0 };
}

const BOLT = '<svg class="bolt" viewBox="0 0 9 12" aria-hidden="true"><path d="M5.6 0 L1 6.6 L4 6.6 L2.8 12 L8 4.8 L5 4.8 Z" fill="currentColor"/></svg>';

// Inline speed badge for HTML lists: bolts, the word and the rating.
export function speedBadge(spd) {
  const s = speedLabel(spd);
  const word = s.bolts || s.slow ? s.word : 'Speed';
  return `<span class="spd ${s.slow ? 'slow' : s.bolts ? 'fast' : ''}" title="Speed ${spd} (20-80 scale)">${BOLT.repeat(s.bolts)}${word} ${spd}</span>`;
}
