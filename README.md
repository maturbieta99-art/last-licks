# Last Licks

Manage the 9th inning of 500 real historic postseason games, and try to win.

**Play:** https://maturbieta99-art.github.io/last-licks/

Every scenario is a real game: the real score, lineups, benches and bullpens going
into the 9th, with players rated from their real season statistics. You manage one
dugout; the computer manages the other and makes the real manager's moves when your
game reaches the same spot.

- One screen on phones and tablets, upright or sideways: score strip, floodlit field,
  the at-bat and a dock of big buttons; everything else slides up in a sheet.
  Installable to the Home Screen
- Call each pitch (type and location, with the batter standing on the side of the
  plate he hits from) or let the catcher call it. Every pitch flies in and lands on
  the zone with its call stamped, and every pitch call or sign gets its own grade
  (Pitch IQ). Auto-play can let routine pitches play themselves
- At the plate, have your hitter look for a pitch in one part of the zone, with the
  pitcher's tendencies for the count shaded in: right guesses hit harder, wrong ones
  get fooled, and a blind guess is worth nothing on average (`tests/look.mjs`)
- Give signs: swing away, take, take until a strike, sit on the fastball, protect,
  sacrifice, squeeze, steal (with the runner's odds), hit and run. Runners carry
  speed ratings and bolts on the field
- Run the bullpen (warm-ups, fatigue, rest days), pinch-hit, pinch-run, make
  defensive changes, set the infield and outfield, walk a hitter
- Every manager call is graded A/B/C/F against the best option by an exact
  win-probability model, with a one-line reason; afterward, see what really happened
  and how the real manager's calls grade against yours
- A coach explains every button in plain English for new players; a hand-picked
  first game; three stars to earn on every game
- Today's game (a new one each day), Win or Go Home, playlists by situation, and the
  full archive of 500. Share cards and challenge links (same game, same luck); save
  codes to back up a record
- A Season Pass (`web/js/ui/pass.js`, off until the Lemon Squeezy product is live)
  can lock the archive behind a license key, checked from the browser
- A night-game look: floodlit field, light-bulb scoreboard, ballpark sound made in
  code (with a mute button)

## How it's built

- `pipeline/` (Python 3.11, standard library only) turns Retrosheet's play-by-play
  and game logs into the scenarios: `scan.py` → `rank.py` (+ `legends.py`) →
  `states.py` → `ratings.py` → `export.py`, writing `web/data/`.
  `validate_states.py` checks every rebuilt lineup against Retrosheet's raw event
  files and replays every real 9th to its real final score.
- `web/js/engine/` is the game: pitch-level model, batted balls and baserunning,
  tactics, win probability, grading and the AI manager. `web/js/ui/` is the interface.
- `tests/` run with Node: `node tests/calib.mjs`, `node tests/wp.mjs`,
  `node tests/simall.mjs 500`, `node tests/starts.mjs`, `node tests/pace.mjs`
  (how often auto-play stops for the player), `node tests/look.mjs` (the look-for-a-pitch
  fairness check) and `node tests/pitchgrade.mjs` (the pitch-call grade scale).

## Working on it

```bash
node tools/serve.mjs          # local preview at http://localhost:8137
node tools/deploy.mjs         # build _site/ and publish it to GitHub Pages
```

Rebuilding the data needs the Retrosheet CSV downloads in `raw/` (not in this repo):
`postseason`, `allpost`, `tiebreakers`, `biodata`, `allplayers`, `batting`,
`pitching` and `fielding` from https://www.retrosheet.org/downloads/csvdownloads.html,
each unzipped into `raw/<name>/x/`.

## Credits

The information used here was obtained free of charge from and is copyrighted by
Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd., Newark, DE 19711.

Not affiliated with, endorsed by or sponsored by Major League Baseball, its clubs or
players. Team and player names identify real games only. Ratings are estimated from
each player's season statistics, and pitch types for most pitchers are estimated
from their profile.
