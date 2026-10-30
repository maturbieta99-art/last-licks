"""Step 4: player ratings, league baselines, rosters and pitcher rest.

Streams Retrosheet's per-game batting, pitching and fielding logs once each.
- Season totals (regular season) for every player-season.
- League baselines per season.
- Rosters: who appeared for each scenario team that postseason (tiebreakers:
  the last 30 days of the regular season plus the tiebreaker games).
- Pitcher workload in the days before each scenario, for rest and fatigue.

Output: build/ratings.json (player-season ratings), build/league.json,
build/rosters.json
"""
import csv
import datetime as dt
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import BUILD, load_json, log, raw_path, read_csv, save_json, to_int  # noqa: E402

POST = {"worldseries", "lcs", "divisionseries", "wildcard", "playoff"}
BAT_F = ["b_pa", "b_ab", "b_r", "b_h", "b_d", "b_t", "b_hr", "b_rbi", "b_sh", "b_sf", "b_hbp",
         "b_w", "b_iw", "b_k", "b_sb", "b_cs", "b_gdp", "b_xi", "b_roe"]
PIT_F = ["p_ipouts", "p_bfp", "p_h", "p_d", "p_t", "p_hr", "p_r", "p_er", "p_w", "p_iw", "p_k",
         "p_hbp", "p_wp", "p_bk", "p_sh", "p_sf", "p_sb", "p_cs", "p_gs", "p_gf", "p_cg"]
FLD_F = ["d_ifouts", "d_po", "d_a", "d_e", "d_dp", "d_pb", "d_sb", "d_cs"]


def ymd(s):
    s = str(s)
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def stream(path):
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        rd = csv.reader(f)
        head = next(rd)
        idx = {h: i for i, h in enumerate(head)}
        for row in rd:
            yield idx, row


def num(v):
    if v == "" or v is None:
        return None
    try:
        return int(v)
    except ValueError:
        try:
            return int(float(v))
        except ValueError:
            return None


class Acc:
    """Sum of fields plus how many rows had each field recorded."""
    __slots__ = ("s", "n", "g")

    def __init__(self, k):
        self.s = [0] * k
        self.n = [0] * k
        self.g = 0

    def add(self, vals):
        self.g += 1
        for i, v in enumerate(vals):
            if v is not None:
                self.s[i] += v
                self.n[i] += 1


def main():
    selected = load_json(f"{BUILD}/selected.json")
    states = load_json(f"{BUILD}/states.json")
    scen = {g["gid"]: g for g in selected}
    scen_dates = {gid: ymd(g["date"]) for gid, g in scen.items()}
    team_seasons = set()
    for g in selected:
        team_seasons.add((g["vis"], g["season"]))
        team_seasons.add((g["home"], g["season"]))
    tb_cut = {}  # tiebreaker team-season -> earliest scenario date
    for g in selected:
        if g["gametype"] == "playoff":
            for t in (g["vis"], g["home"]):
                d = ymd(g["date"])
                tb_cut[(t, g["season"])] = min(d, tb_cut.get((t, g["season"]), d))

    # pitcher -> list of (date, gid, bf, gs) for workload, only for scenario team-seasons
    workload = defaultdict(list)
    exact_pitches = {}  # (gid, pid) -> pitches from postseason play-by-play
    for ds in ("postseason", "tiebreakers"):
        for r in read_csv(raw_path(ds, "plays.csv")):
            n = to_int(r["nump"], -1)
            if n > 0:
                k = (r["gid"], r["pitcher"])
                exact_pitches[k] = exact_pitches.get(k, 0) + n
    log("exact pitch counts for", len(exact_pitches), "pitcher-games")

    # ---- batting
    bat = {}
    lg_bat = defaultdict(lambda: Acc(len(BAT_F)))
    roster = defaultdict(lambda: defaultdict(set))  # (team, season) -> pid -> set(kinds)
    reg_dates = defaultdict(dict)  # (team, season) -> pid -> last regular-season date
    pitchers_by_season = defaultdict(set)
    allp = defaultdict(dict)
    for r in read_csv(raw_path("allplayers", "allplayers.csv")):
        season = to_int(r["season"])
        g = to_int(r["g"])
        pos = {k: to_int(r[f"g_{k}"]) for k in ("p", "c", "1b", "2b", "3b", "ss", "lf", "cf", "rf", "of", "dh", "ph", "pr")}
        key = (r["id"], season)
        cur = allp.get(key)
        if cur:
            cur["g"] += g
            for k, v in pos.items():
                cur["pos"][k] += v
            cur["teams"].append(r["team"])
        else:
            allp[key] = {"g": g, "pos": pos, "teams": [r["team"]], "bat": r["bat"], "throw": r["throw"]}
    for (pid, season), a in allp.items():
        if a["pos"]["p"] * 2 > a["g"]:
            pitchers_by_season[season].add(pid)
    log("allplayers loaded", len(allp))

    n = 0
    for idx, row in stream(raw_path("batting", "batting.csv")):
        n += 1
        if row[idx["stattype"]] != "value":
            continue
        gt = row[idx["gametype"]]
        pid = row[idx["id"]]
        team = row[idx["team"]]
        date = row[idx["date"]]
        season = int(date[:4])
        if gt == "regular":
            vals = [num(row[idx[f]]) for f in BAT_F]
            key = (pid, season)
            a = bat.get(key)
            if a is None:
                a = bat[key] = Acc(len(BAT_F))
            a.add(vals)
            grp = "p" if pid in pitchers_by_season[season] else "b"
            lg_bat[(season, grp)].add(vals)
            if (team, season) in tb_cut:
                reg_dates[(team, season)][pid] = max(date, reg_dates[(team, season)].get(pid, "0"))
        elif gt in POST and (team, season) in team_seasons:
            roster[(team, season)][pid].add("b")
    log("batting rows", n, "player-seasons", len(bat))

    # ---- pitching
    pit = {}
    n = 0
    for idx, row in stream(raw_path("pitching", "pitching.csv")):
        n += 1
        if row[idx["stattype"]] != "value":
            continue
        gt = row[idx["gametype"]]
        pid = row[idx["id"]]
        team = row[idx["team"]]
        date = row[idx["date"]]
        season = int(date[:4])
        gid = row[idx["gid"]]
        if gt == "regular":
            vals = [num(row[idx[f]]) for f in PIT_F]
            vals.append(1 if row[idx["wp"]] == "1" else 0)
            vals.append(1 if row[idx["lp"]] == "1" else 0)
            vals.append(1 if row[idx["save"]] == "1" else 0)
            key = (pid, season)
            a = pit.get(key)
            if a is None:
                a = pit[key] = Acc(len(PIT_F) + 3)
            a.add(vals)
            if (team, season) in tb_cut:
                reg_dates[(team, season)][pid] = max(date, reg_dates[(team, season)].get(pid, "0"))
        elif gt in POST and (team, season) in team_seasons:
            roster[(team, season)][pid].add("p")
        if (team, season) in team_seasons:
            bf = num(row[idx["p_bfp"]]) or 0
            gs = num(row[idx["p_gs"]]) or 0
            pc = exact_pitches.get((gid, pid))
            workload[pid].append((date, gid, bf, gs, pc))
    log("pitching rows", n, "pitcher-seasons", len(pit))

    # ---- fielding
    fld = {}
    lg_fld = defaultdict(lambda: Acc(len(FLD_F)))
    n = 0
    for idx, row in stream(raw_path("fielding", "fielding.csv")):
        n += 1
        if row[idx["stattype"]] != "value" or row[idx["gametype"]] != "regular":
            continue
        pid = row[idx["id"]]
        season = int(row[idx["date"]][:4])
        pos = num(row[idx["d_pos"]])
        if not pos or pos > 9:
            continue
        vals = [num(row[idx[f]]) for f in FLD_F]
        key = (pid, season, pos)
        a = fld.get(key)
        if a is None:
            a = fld[key] = Acc(len(FLD_F))
        a.add(vals)
        lg_fld[(season, pos)].add(vals)
    log("fielding rows", n, "player-season-positions", len(fld))

    # ---- league baselines
    league = {}
    seasons = sorted({s for (s, _) in lg_bat})
    for s in seasons:
        b = lg_bat.get((s, "b"))
        p = lg_bat.get((s, "p"))
        if not b:
            continue
        league[s] = {"bat": dict(zip(BAT_F, b.s)), "batn": dict(zip(BAT_F, b.n)),
                     "pbat": dict(zip(BAT_F, p.s)) if p else None,
                     "fld": {pos: dict(zip(FLD_F, lg_fld[(s, pos)].s)) for pos in range(1, 10) if (s, pos) in lg_fld}}

    # ---- rosters for scenarios
    rosters = {}
    for gid, g in scen.items():
        d = scen_dates[gid]
        out = []
        for side, team in ((0, g["vis"]), (1, g["home"])):
            key = (team, g["season"])
            members = dict(roster.get(key, {}))
            if g["gametype"] == "playoff":
                cut = tb_cut[key]
                for pid, last in reg_dates.get(key, {}).items():
                    if (cut - ymd(last)).days <= 30:
                        kinds = members.setdefault(pid, set())
                        kinds.add("p" if pid in pitchers_by_season[g["season"]] else "b")
            entries = []
            for pid, kinds in members.items():
                # rest: workload in the 6 days before this game, decayed
                debt = 0.0
                recent = []
                for (date, wgid, bf, gs, pc) in workload.get(pid, []):
                    days = (d - ymd(date)).days
                    if wgid == gid or days < 0 or days > 6:
                        continue
                    if days == 0 and wgid > gid:
                        continue
                    pitches = pc if pc else bf * 3.85
                    decay = (1.0, 0.75, 0.5, 0.3, 0.15, 0.06, 0.02)[days]
                    debt += pitches * decay
                    recent.append([days, round(pitches), gs])
                energy = max(0.15, min(1.0, 1 - debt / 110))
                entries.append({"p": pid, "k": "".join(sorted(kinds)), "en": round(energy, 2),
                                "recent": sorted(recent)})
            out.append(entries)
        rosters[gid] = out

    # ---- which player-seasons we need
    need = set()
    for gid, g in scen.items():
        st = states[gid]
        for side in (0, 1):
            for pid, _ in st["start"]["lineups"][side]:
                need.add((pid, g["season"]))
            if st["start"]["pitchers"][side]:
                need.add((st["start"]["pitchers"][side], g["season"]))
            for e in rosters[gid][side]:
                need.add((e["p"], g["season"]))
        for h in st["history"]:
            need.add((h["b"], g["season"]))
            need.add((h["p"], g["season"]))
            for sub in h["subs"]:
                need.add((sub["in"], g["season"]))

    ratings = {}
    for pid, season in need:
        rec = {"g": allp.get((pid, season), {}).get("g", 0)}
        a = allp.get((pid, season))
        if a:
            rec["pos"] = a["pos"]
            rec["bat"] = a["bat"]
            rec["throw"] = a["throw"]
        b = bat.get((pid, season))
        if b:
            rec["B"] = [b.s, b.n, b.g]
        b0 = bat.get((pid, season - 1))
        if b0:
            rec["B0"] = [b0.s, b0.n, b0.g]
        p = pit.get((pid, season))
        if p:
            rec["P"] = [p.s, p.n, p.g]
        p0 = pit.get((pid, season - 1))
        if p0:
            rec["P0"] = [p0.s, p0.n, p0.g]
        fl = {}
        for pos in range(1, 10):
            f = fld.get((pid, season, pos))
            if f:
                fl[pos] = f.s
        if fl:
            rec["F"] = fl
        ratings[f"{pid}:{season}"] = rec

    save_json(f"{BUILD}/ratings_raw.json", ratings)
    save_json(f"{BUILD}/league.json", {str(k): v for k, v in league.items()})
    save_json(f"{BUILD}/rosters.json", rosters)
    log("player-seasons needed", len(need), "saved", len(ratings))


if __name__ == "__main__":
    main()
