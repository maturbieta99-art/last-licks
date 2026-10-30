"""Step 1: scan postseason and tiebreaker games for 9th-inning scenario candidates.

Output: build/candidates.json, one record per game with the score entering the
9th, the 9th+ win-expectancy path, drama metrics, series state and a count of the
real managers' moves from the 9th on.
"""
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (BUILD, MLB_POST_TYPES, ensure_dirs, log, raw_path, read_csv,
                    save_json, series_length, to_int)
from we import home_we

SETS = ("postseason", "tiebreakers")


def bases_of(row, suffix="pre"):
    b = 0
    for i in range(3):
        if row.get(f"br{i + 1}_{suffix}"):
            b |= 1 << i
    return b


def load_games():
    games = {}
    for ds in SETS:
        for r in read_csv(raw_path(ds, "gameinfo.csv")):
            gt = r["gametype"]
            if ds == "postseason" and gt not in MLB_POST_TYPES:
                continue
            season = to_int(r["season"])
            # Negro League playoffs share these gametypes before MLB had the rounds
            if (gt == "lcs" and season < 1969) or (gt == "divisionseries" and season < 1981):
                continue
            if ds == "tiebreakers" and (gt != "playoff" or r["season"] == "1936"):
                continue
            if r["pbp"] not in ("y", "d"):
                continue
            vr, hr = to_int(r["vruns"], -1), to_int(r["hruns"], -1)
            if vr < 0 or hr < 0:
                continue  # skip unfinished games
            games[r["gid"]] = {
                "gid": r["gid"], "set": ds, "gametype": gt, "season": to_int(r["season"]),
                "date": r["date"], "number": to_int(r["number"]), "vis": r["visteam"],
                "home": r["hometeam"], "site": r["site"], "usedh": r["usedh"].upper() == "TRUE",
                "innings": to_int(r["innings"], 9), "final": [vr, hr], "pbp": r["pbp"],
                "wp": r["wp"], "lp": r["lp"], "save": r["save"],
                "daynight": r["daynight"], "attendance": to_int(r["attendance"]),
                "tie": vr == hr,
            }
    return games


def load_teamstats(games):
    for ds in SETS:
        for r in read_csv(raw_path(ds, "teamstats.csv")):
            g = games.get(r["gid"])
            if not g or r["stattype"] != "value":
                continue
            side = 0 if r["team"] == g["vis"] else 1
            line = []
            for i in range(1, 29):
                v = r[f"inn{i}"]
                if v == "":
                    break
                line.append(to_int(v))
            g.setdefault("line", [None, None])[side] = line
            g.setdefault("mgr", [None, None])[side] = r["mgr"]


def add_series_info(games):
    groups = defaultdict(list)
    for g in games.values():
        key = (g["season"], g["gametype"], tuple(sorted((g["vis"], g["home"]))))
        groups[key].append(g)
    for (season, gt, teams), gl in groups.items():
        gl.sort(key=lambda g: (g["date"], g["number"]))
        n = series_length(season, gt, teams)
        need = n // 2 + 1
        wins = {teams[0]: 0, teams[1]: 0}
        for i, g in enumerate(gl):
            g["game_no"] = i + 1
            g["series_len"] = n
            g["wins_before"] = [wins[g["vis"]], wins[g["home"]]]
            g["need"] = need
            if not g["tie"]:
                winner = g["vis"] if g["final"][0] > g["final"][1] else g["home"]
                wins[winner] += 1
            g["series_games"] = len(gl)


def stream_plays(games):
    """Yield (gid, rows) for games of interest, rows in order."""
    for ds in SETS:
        cur, rows = None, []
        for r in read_csv(raw_path(ds, "plays.csv")):
            gid = r["gid"]
            if gid != cur:
                if cur in games and rows:
                    yield cur, rows
                cur, rows = gid, []
            if gid in games:
                rows.append(r)
        if cur in games and rows:
            yield cur, rows


def analyze(g, rows):
    # Score entering the 9th from the line score
    line = g.get("line")
    if not line or not line[0] or not line[1] or len(line[0]) < 8 or len(line[1]) < 8:
        return None
    s9 = [sum(line[0][:8]), sum(line[1][:8])]
    late = [r for r in rows if to_int(r["inning"]) >= 9]
    if not late or to_int(late[0]["inning"]) != 9 or late[0]["top_bot"] != "0":
        return None
    # Check the first 9th-inning row matches the line score
    if [to_int(late[0]["score_v"]), to_int(late[0]["score_h"])] != s9:
        return None

    # Win expectancy path (home perspective)
    path = []
    for r in late:
        half = to_int(r["top_bot"])
        outs = to_int(r["outs_pre"])
        if outs >= 3:
            outs = 2
        diff = to_int(r["score_h"]) - to_int(r["score_v"])
        path.append(home_we(half, outs, bases_of(r), diff))
    home_won = g["final"][1] > g["final"][0]
    path.append(1.0 if home_won else 0.0)
    deltas = [path[i + 1] - path[i] for i in range(len(path) - 1)]
    excitement = sum(abs(d) for d in deltas)
    winner_path = path if home_won else [1 - p for p in path]
    comeback = 1 - min(winner_path)
    # Lead changes and ties created from the 9th on
    changes = 0
    prev = (s9[1] > s9[0]) - (s9[1] < s9[0])
    for r in late[1:] + [None]:
        if r is None:
            sv, sh = g["final"]
        else:
            sv, sh = to_int(r["score_v"]), to_int(r["score_h"])
        cur = (sh > sv) - (sh < sv)
        if cur != prev:
            changes += 1
            prev = cur
    last = late[-1]
    walkoff = home_won and last["top_bot"] == "1"

    # Real managers' moves from the 9th on
    moves = 0
    last_pitcher = {}
    last_lf = {}
    for r in rows:
        inn = to_int(r["inning"])
        fteam = r["pitteam"]
        bteam = r["batteam"]
        lf = [r[f"lf{i}"] for i in range(1, 10)]
        if inn >= 9:
            if fteam in last_pitcher and last_pitcher[fteam] != r["pitcher"]:
                moves += 1
            if r["bat_f"] == "11" and r["pa"] == "1":
                moves += 1
            if bteam in last_lf:
                moves += sum(1 for a, b in zip(last_lf[bteam], lf) if b == "12" and a != "12")
            moves += to_int(r["iw"]) + to_int(r["sh"])
            moves += sum(to_int(r[k]) for k in ("sb2", "sb3", "sbh", "cs2", "cs3", "csh"))
        last_pitcher[fteam] = r["pitcher"]
        last_lf[bteam] = lf

    # Biggest single swing in the 9th or later, and the start of that PA
    key = max(range(len(deltas)), key=lambda i: abs(deltas[i]))
    pa_start = key
    while pa_start > 0:
        prev_r = late[pa_start - 1]
        same_half = prev_r["inning"] == late[pa_start]["inning"] and prev_r["top_bot"] == late[pa_start]["top_bot"]
        same_slot = prev_r["lp"] == late[pa_start]["lp"]
        if same_half and same_slot and prev_r["pa"] != "1":
            pa_start -= 1
        else:
            break

    return {
        "score9": s9,
        "we9": path[0],
        "excitement": round(excitement, 4),
        "comeback": round(comeback, 4),
        "changes": changes,
        "walkoff": walkoff,
        "moves9": moves,
        "late_rows": len(late),
        "key": key,
        "key_pa": pa_start,
        "key_swing": round(deltas[key], 4),
        "key_event": late[key]["event"],
        "key_batter": late[key]["batter"],
        "max_inning": to_int(late[-1]["inning"]),
    }


def main():
    ensure_dirs()
    games = load_games()
    log("games with pbp:", len(games))
    load_teamstats(games)
    add_series_info(games)
    out = []
    for gid, rows in stream_plays(games):
        if games[gid]["tie"]:
            continue
        a = analyze(games[gid], rows)
        if a:
            g = dict(games[gid])
            g.update(a)
            out.append(g)
    log("analyzable games:", len(out))
    close = [g for g in out if abs(g["score9"][0] - g["score9"][1]) <= 3]
    log("entered 9th within 3 runs:", len(close))
    by_type = defaultdict(int)
    for g in close:
        by_type[g["gametype"]] += 1
    log("by round:", dict(by_type))
    save_json(f"{BUILD}/candidates.json", out)


if __name__ == "__main__":
    main()
