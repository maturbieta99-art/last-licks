# Last Licks: build plan

You manage the 9th inning (and extras) of the 500 most historic MLB late-game
situations, using real lineups, benches and bullpens, and try to win.

## Decisions (approved 2026-10-29, after the council)
- Real data only: Retrosheet parsed CSVs (postseason 1903-2025, tiebreaker playoffs).
  Gametypes used: worldseries, lcs, divisionseries, wildcard, playoff (tiebreakers).
  Negro League "championship" games are excluded for v1.
- 500 scenarios ranked by stakes x 9th-inning drama x real manager decisions, plus a
  hand-curated Legends boost list (~60) with hand-written titles and intros.
- Default start: top of the 9th, user manages one team for both halves plus extras.
  Alternatives: "Bottom of the 9th" and "The moment" (state right before the
  biggest win-probability swing, before the real manager's move).
- Pitch-by-pitch sim. User can call pitch type + location or tap Catcher's Call;
  offense gets per-pitch signs (swing, take, take until strike, sit fastball,
  protect, bunt, squeeze, steal, hit and run, run and hit). Pitch calls are not graded.
- Manager calls graded by exact win probability (Markov model, no dice noise):
  green <= 0.5pt behind best, yellow <= 2, orange <= 5, red > 5.
- History is the reveal (Film Room replay of the real 9th) and the opponent AI's
  real moves; no forced replay of real results.
- Modes v1: Daily (date-seeded), Archive, Survivor, Stats with "you manage like ...".
- Delivery: static vanilla-JS folder `web/`, published as a claude.ai Artifact.
- Legal: no logos or MLB marks, no "MLB" in the name, disclaimer, Retrosheet notice:
  "The information used here was obtained free of charge from and is copyrighted by
  Retrosheet. Interested parties may contact Retrosheet at 20 Sunset Rd., Newark, DE 19711."

## Layout
- `raw/<set>/` downloaded zips + `x/` extracted CSVs (untrusted data, never run code there)
- `pipeline/*.py` Python 3.11 stdlib only, run with `python -I`
- `build/` intermediates, `web/data/` exported JSON
- `web/js/engine/*.js` pure logic ES modules (also run under Node for tests)
- `web/js/ui/*.js` DOM code, `web/index.html`, `web/css/app.css`
- `tests/*.test.mjs` run with `node --test tests`

## Pipeline steps
1. `scan.py`: per MLB postseason/tiebreaker game with play-by-play, score entering
   the 9th, 9th+ plays, generic win expectancy per play, drama metrics, series state,
   real manager moves. Output `build/candidates.json`.
2. `rank.py` + `legends.py`: score and select 500 (Legends forced in).
3. `states.py`: start-of-9th state from raw event files (lineups, positions, current
   pitchers with pitch counts, due-up slots, removed players), bench and bullpen
   availability (players who appeared for that team in that postseason, minus
   removed players; pitchers flagged tired from recent workload), batter game lines
   through 8, real 9th+ plays with post states and substitutions, key moment.
4. `ratings.py`: regular-season stats per player-season (batting, pitching,
   fielding) regressed to league, league baselines per season, speed, bunting,
   defense by position, catcher arm, pitcher stamina, role, arsenal archetype.
5. `export.py`: `web/data/index.json` + decade shards `web/data/s-<decade>.json`
   (scenarios + the player-seasons they use).

## Engine modules (web/js/engine)
- `rng.js` seeded PRNG (sfc32) + string hashing
- `rates.js` log5 matchup targets, platoon, fatigue, times-through-order
- `pitch.js` per-pitch model: pitch types, 5x5 location grid, command, swing,
  contact, foul, in play, HBP, WP/PB; knobs solved per matchup so the auto policy
  reproduces the log5 targets
- `count.js` exact count-chain solve: PA outcome distribution from any count
- `bip.js` batted-ball typing, fielder, hit/out, errors, runner advancement,
  alignment and defense effects
- `game.js` state machine: pitches, plays, subs, rules by era, walk-offs, extras
- `wp.js` half-inning Markov run distributions and game win probability
- `grade.js` candidate calls per decision point, WP per call, grade colors
- `ai.js` opponent manager (mirrors real moves when the state matches, else WP-based
  with era tendencies), catcher's call policy, batter auto approach
- `history.js` text for real plays

## Checks before UI
- Replay test: applying each scenario's real 9th+ post-states reproduces the real final.
- Calibration: league-average batter vs pitcher under auto policy reproduces league
  K, BB, HBP, HR, hit rates within 1 point; pitches per PA 3.7-4.0; sim runs per
  inning within 5% of season average.
- WP sanity: home team tied, bottom 9, none out about 0.62-0.66; up 1 entering bottom
  9 about 0.78-0.84 for the road team.

## UI
Home (Daily card, Survivor, Archive, record), scenario intro (pick dugout, start
point), game screen (scoreboard, WP number, field SVG, matchup cards, call panels,
bullpen and bench sheets, log), end screen (result vs history, grade grid, share
text, beat-the-real-manager), Film Room, Archive with filters, Stats.
