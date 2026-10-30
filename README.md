# Last Licks

Manage the 9th inning of 500 real historic postseason games, and try to win.

**Play:** https://maturbieta99-art.github.io/last-licks/

Every scenario is a real game: the real score, lineups, benches and bullpens going
into the 9th, with players rated from their real season statistics. You manage one
dugout; the computer manages the other and makes the real manager's moves when your
game reaches the same spot.

- Call each pitch (type and location, with the batter's silhouette on the side of the
  plate he hits from) or let the catcher call it. Every pitch lands on the zone with
  its call stamped; routine pitches play themselves, and the game stops you for the
  first pitch of each at-bat, the big counts and new situations ("Every pitch" turns
  that off)
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
  full archive of 500
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
  `node tests/simall.mjs 500`, `node tests/starts.mjs`, and `node tests/pace.mjs`
  (how often the default pacing stops for the player).

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
