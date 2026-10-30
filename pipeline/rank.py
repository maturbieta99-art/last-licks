"""Step 2: score candidates and select the 500 scenarios.

score = round weight x game importance x (9th-inning drama + real decisions),
with Legends (legends.py) forced to the top.
"""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import BUILD, load_json, log, save_json  # noqa: E402
from legends import LEGENDS  # noqa: E402

TARGET = 500
ROUND_W = {"worldseries": 1.0, "lcs": 0.75, "divisionseries": 0.55,
           "wildcard": 0.5, "playoff": 0.8}


def importance(g):
    n, need = g["series_len"], g["need"]
    wv, wh = g["wins_before"]
    if n == 1 or (wv == need - 1 and wh == need - 1):
        return 2.0, "winner-take-all"
    if wv == need - 1 or wh == need - 1:
        return 1.45, "elimination"
    return 0.9 + 0.05 * g["game_no"], ""


def score(g):
    imp, tag = importance(g)
    drama = (g["excitement"] + 1.2 * g["comeback"] + 0.25 * g["walkoff"]
             + 0.1 * g["changes"])
    decisions = 0.05 * min(g["moves9"], 10)
    return ROUND_W[g["gametype"]] * imp * (drama + decisions), tag


def main():
    cands = load_json(f"{BUILD}/candidates.json")
    by_key = {}
    for g in cands:
        by_key[(g["season"], g["gametype"], g["game_no"], g["home"])] = g
    chosen = {}
    for i, lg in enumerate(LEGENDS):
        key = (lg["season"], lg["round"], lg["game"], lg["home"])
        g = by_key.get(key)
        if not g:
            log("LEGEND NOT FOUND", key)
            continue
        s, tag = score(g)
        g["score"] = round(s, 4)
        g["stakes_tag"] = tag
        g["legend"] = i
        chosen[g["gid"]] = g
    pool = []
    for g in cands:
        if g["gid"] in chosen:
            continue
        diff = abs(g["score9"][0] - g["score9"][1])
        if diff > 3 and g["comeback"] < 0.5:
            continue
        s, tag = score(g)
        g["score"] = round(s, 4)
        g["stakes_tag"] = tag
        pool.append(g)
    pool.sort(key=lambda g: -g["score"])
    rest = pool[: TARGET - len(chosen)]
    legends = sorted(chosen.values(), key=lambda g: g["legend"])
    selected = legends + rest
    for rank, g in enumerate(selected, 1):
        g["rank"] = rank
    save_json(f"{BUILD}/selected.json", selected)
    log("selected", len(selected), "legends", len(legends))
    log("by round", Counter(g["gametype"] for g in selected))
    log("by decade", sorted(Counter(g["season"] // 10 * 10 for g in selected).items()))
    log("cutoff score", rest[-1]["score"] if rest else None)
    for g in rest[:40]:
        log(g["rank"], g["gid"], g["gametype"], "G%d" % g["game_no"], g["vis"], "@", g["home"],
            g["score9"], "->", g["final"], g["key_event"], g["key_batter"], g["score"])


if __name__ == "__main__":
    main()
