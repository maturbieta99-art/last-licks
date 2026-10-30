// Plain-English play descriptions for simulated plays.

const FIELD = { 1: 'the pitcher', 2: 'the catcher', 3: 'first', 4: 'second', 5: 'third', 6: 'short', 7: 'left', 8: 'center', 9: 'right' };
const FIELDER = { 1: 'pitcher', 2: 'catcher', 3: 'first baseman', 4: 'second baseman', 5: 'third baseman', 6: 'shortstop', 7: 'left fielder', 8: 'center fielder', 9: 'right fielder' };
const GAP = { 7: 'left', 8: 'center', 9: 'right' };

export const fieldName = (pos) => FIELD[pos] || '';
export const fielderName = (pos) => FIELDER[pos] || 'fielder';

export function joinNames(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// category: HR B3 B2 B1 OUT ROE; prof: {bb, field, depth}; note from the branch
export function describeFair(batterName, category, prof, note, scoredNames, outsBefore, outsAfter) {
  const f = prof ? prof.field : 8;
  const deep = prof && prof.depth === 'deep';
  let s;
  switch (category) {
    case 'HR': {
      const n = scoredNames.length;
      const kind = n >= 4 ? 'a grand slam' : n === 3 ? 'a three-run homer' : n === 2 ? 'a two-run homer' : 'a solo homer';
      s = `${batterName} hits ${kind} to ${deep || f >= 7 ? (GAP[f] || 'left') : 'left'}`;
      return s + '.';
    }
    case 'B3': s = `${batterName} triples to ${GAP[f] || 'right'}`; break;
    case 'B2': s = prof && prof.depth === 'line' ? `${batterName} doubles down the line` : `${batterName} doubles to ${deep ? 'deep ' : ''}${GAP[f] || 'left'}`; break;
    case 'B1':
      if (prof && prof.bb === 'G' && f <= 6) s = `${batterName} singles through the infield`;
      else if (prof && prof.bb === 'F') s = `${batterName} bloops a single to ${GAP[f] || 'center'}`;
      else s = `${batterName} singles to ${GAP[f] || 'center'}`;
      break;
    case 'ROE': s = `${batterName} reaches on an error by the ${fielderName(f)}`; break;
    default: {
      const bb = prof ? prof.bb : 'G';
      if (note && note.includes('double play') && bb === 'G') s = `${batterName} grounds into a double play`;
      else if (note && note.includes('double play') && bb === 'L') s = `${batterName} lines into a double play`;
      else if (note && note.includes('double play')) s = `${batterName} flies into a double play`;
      else if (bb === 'G') s = note && note.includes('force') ? `${batterName} grounds into a force out` : `${batterName} grounds out to ${FIELD[f]}`;
      else if (bb === 'L') s = `${batterName} lines out to ${FIELD[f]}`;
      else if (bb === 'P') s = `${batterName} pops out to ${FIELD[f]}`;
      else if (note && note.includes('sacrifice')) s = `${batterName} hits a sacrifice fly to ${FIELD[f]}`;
      else s = `${batterName} flies out to ${deep ? 'deep ' : ''}${FIELD[f]}`;
    }
  }
  const extras = [];
  if (note && /thrown out at third/.test(note)) extras.push('a runner is thrown out at third');
  if (note && /out at the plate/.test(note)) extras.push('a runner is thrown out at the plate');
  if (note && /takes second on the throw/.test(note)) extras.push('he takes second on the throw');
  if (note && /tags to third/.test(note)) extras.push('the runner tags up to third');
  if (scoredNames.length && category !== 'HR') extras.push(`${joinNames(scoredNames)} ${scoredNames.length === 1 ? 'scores' : 'score'}`);
  return s + (extras.length ? '; ' + extras.join('; ') : '') + '.';
}

export const PITCH_WORD = { ball: 'Ball', called: 'Called strike', swinging: 'Swinging strike', foul: 'Foul', hbp: 'Hit by pitch', inplay: 'In play' };
