"""Checks for build/states.json.

1. Lineup check: for postseason games, compare the inferred start-of-9th lineups
   and pitchers with Retrosheet's raw event files (explicit start/sub records).
2. Replay check: walking the real 9th+ plays from the start state must end at
   the real final score, with outs and runs consistent at every step.
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import BUILD, RAW, load_json, log  # noqa: E402


def raw_start_states(want):
    """gid -> ([slots_v, slots_h], [pitcher_v, pitcher_h]) at the first 9th-inning play."""
    out = {}
    for path in glob.glob(os.path.join(RAW, "allpost", "x", "*.EV*")):
        gid = None
        slots = pitch = None
        done = False
        with open(path, encoding="latin-1") as f:
            for line in f:
                parts = line.rstrip("\r\n").split(",")
                kind = parts[0]
                if kind == "id":
                    gid = parts[1]
                    slots = [[None] * 9, [None] * 9]
                    pitch = [None, None]
                    done = gid not in want
                    continue
                if done or gid is None:
                    continue
                if kind in ("start", "sub"):
                    pid, team, slot, pos = parts[1], int(parts[-3]), int(parts[-2]), int(parts[-1])
                    if slot > 0:
                        slots[team][slot - 1] = [pid, pos]
                    if pos == 1:
                        pitch[team] = pid
                    elif pitch[team] == pid:
                        pitch[team] = None
                elif kind == "play" and int(parts[1]) >= 9:
                    out[gid] = ([list(map(list, s)) for s in slots], list(pitch))
                    done = True
    return out


def check_lineups(states, games):
    want = {gid for gid, g in games.items() if g["set"] == "postseason"}
    raw = raw_start_states(want)
    n = ok = 0
    bad = []
    for gid in want:
        if gid not in raw or gid not in states:
            continue
        n += 1
        mine = states[gid]["start"]
        rs, rp = raw[gid]
        same = True
        for side in (0, 1):
            for x, y in zip(mine["lineups"][side], rs[side]):
                if not y or x[0] != y[0]:
                    same = False
                elif x[1] != y[1] and not (x[1] == 10 and y[1] in (11, 12)):
                    same = False
            if mine["pitchers"][side] and mine["pitchers"][side] != rp[side]:
                same = False
        if same:
            ok += 1
        else:
            bad.append(gid)
    log(f"lineup check: {ok}/{n} games match raw event files")
    return bad, raw


def check_replay(states, games):
    bad = []
    for gid, st in states.items():
        g = games[gid]
        hist = st["history"]
        score = list(hist[0]["s0"])
        expected9 = g["score9"]
        if score != expected9:
            bad.append((gid, "start score", score, expected9))
            continue
        prev = None
        for h in hist:
            if prev is not None:
                if (h["i"], h["h"]) == (prev["i"], prev["h"]):
                    runners = list(prev["r1"])
                    for sub in h["subs"]:
                        if sub["k"] == "pr" and sub["out"] in runners:
                            runners[runners.index(sub["out"])] = sub["in"]
                    if h["o0"] != prev["o1"] or h["r0"] != runners:
                        bad.append((gid, "state gap", prev["ev"], h["ev"]))
                        break
                elif prev["o1"] != 3:
                    bad.append((gid, "half ended early", prev["ev"], prev["o1"]))
                    break
            if h["s0"] != score:
                bad.append((gid, "score drift", h["s0"], score))
                break
            score = list(h["s1"])
            prev = h
        else:
            if score != g["final"]:
                bad.append((gid, "final", score, g["final"]))
    log(f"replay check: {len(states) - len(bad)}/{len(states)} replays reach the real final")
    return bad


def main():
    states = load_json(f"{BUILD}/states.json")
    games = {g["gid"]: g for g in load_json(f"{BUILD}/selected.json")}
    bad_l, raw = check_lineups(states, games)
    for gid in bad_l[:30]:
        mine = states[gid]["start"]
        rs, rp = raw[gid]
        log("MISMATCH", gid)
        for side in (0, 1):
            for i, (a, b) in enumerate(zip(mine["lineups"][side], rs[side])):
                if tuple(a) != tuple(b or ()):
                    log("   side", side, "slot", i + 1, "mine", a, "raw", b)
            if mine["pitchers"][side] != rp[side]:
                log("   side", side, "pitcher mine", mine["pitchers"][side], "raw", rp[side])
    bad_r = check_replay(states, games)
    for b in bad_r[:12]:
        log("REPLAY", b)


if __name__ == "__main__":
    main()
