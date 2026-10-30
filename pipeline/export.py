"""Step 5: derive ratings and write the game's data files.

web/data/index.json  - the 500 scenarios (summary rows, rank order)
web/data/s-<decade>.json - full scenarios for one decade + their player-seasons
"""
import hashlib
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (BUILD, WEB_DATA, ensure_dirs, load_json, load_managers, load_parks,  # noqa: E402
                    load_people, load_teams, log, save_json, team_name)
from legends import LEGENDS  # noqa: E402

AL = {"NYA", "BOS", "BAL", "TOR", "TBA", "CLE", "DET", "CHA", "KCA", "MIN", "OAK", "SEA", "TEX",
      "CAL", "ANA", "WS1", "WS2", "SLA", "PHA", "KC1", "SE1", "MLA"}


def league_of(team, season):
    if team == "MIL":
        return "AL" if season <= 1997 else "NL"
    if team == "HOU":
        return "AL" if season >= 2013 else "NL"
    return "AL" if team in AL else "NL"


def h01(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


# ---------------------------------------------------------------- league
BAT = ["pa", "ab", "r", "h", "d", "t", "hr", "rbi", "sh", "sf", "hbp", "w", "iw", "k", "sb",
       "cs", "gdp", "xi", "roe"]
B = {k: i for i, k in enumerate(BAT)}
PIT = ["ipouts", "bfp", "h", "d", "t", "hr", "r", "er", "w", "iw", "k", "hbp", "wp", "bk", "sh",
       "sf", "sb", "cs", "gs", "gf", "cg", "win", "loss", "save"]
P = {k: i for i, k in enumerate(PIT)}
RATE_KEYS = ("k", "bb", "hbp", "hr", "b1", "b2", "b3")


def bat_rates(t):
    """Per-PA rates (PA excluding sacrifice bunts) from a dict of batting totals."""
    pa = t["pa"] or (t["ab"] + t["w"] + t["hbp"] + t["sh"] + t["sf"])
    pa2 = max(1, pa - t["sh"])
    singles = t["h"] - t["d"] - t["t"] - t["hr"]
    return {
        "k": t["k"] / pa2, "bb": (t["w"] - t["iw"]) / pa2, "hbp": t["hbp"] / pa2,
        "hr": t["hr"] / pa2, "b1": singles / pa2, "b2": t["d"] / pa2, "b3": t["t"] / pa2,
        "roe": t["roe"] / pa2, "pa": pa2,
    }


def build_league(raw):
    out = {}
    for season, L in raw.items():
        b = {k[2:]: v for k, v in L["bat"].items()}
        p = {k[2:]: v for k, v in L["pbat"].items()} if L["pbat"] else {k: 0 for k in BAT}
        allb = {k: b[k] + p[k] for k in BAT}
        rb, rp, ra = bat_rates(b), bat_rates(p), bat_rates(allb)
        # errors per PA (for reached-on-error), steals
        fl = L["fld"]
        errs = sum(fl[str(pos)]["d_e"] for pos in range(1, 10) if str(pos) in fl) if fl else 0
        roe = ra["roe"] if L["batn"]["b_roe"] > 0.5 * L["batn"]["b_pa"] else 0.45 * errs / max(1, ra["pa"])
        att = b["sb"] + b["cs"]
        sbpct = b["sb"] / att if b["cs"] > 0 else 0.68
        times_on = max(1, b["h"] - b["d"] - b["t"] - b["hr"] + b["w"] + b["hbp"])
        fpos = {}
        for pos in range(2, 10):
            f = fl.get(str(pos)) if fl else None
            if f and f["d_ifouts"] > 0:
                ch = f["d_po"] + f["d_a"]
                fpos[pos] = {"rf": ch * 27 / f["d_ifouts"], "fp": ch / max(1, ch + f["d_e"]),
                             "a": f["d_a"] * 27 / f["d_ifouts"],
                             "cs": (f["d_cs"] / max(1, f["d_sb"] + f["d_cs"])) if pos == 2 and f["d_cs"] else 0.33}
        out[int(season)] = {
            "all": {k: ra[k] for k in RATE_KEYS}, "pos": {k: rb[k] for k in RATE_KEYS},
            "pit": {k: rp[k] for k in RATE_KEYS}, "roe": roe, "sbpct": sbpct,
            "sbatt": att / times_on, "sh": b["sh"] / max(1, rb["pa"]),
            "tri": b["t"] / max(1, b["d"] + b["t"]),
            "run": (b["r"] - b["hr"]) / max(1, b["h"] + b["w"] + b["hbp"] - b["hr"]),
            "gdp": b["gdp"] / max(1, rb["pa"]), "fld": fpos,
            "hpb": (b["h"] - b["hr"]) / max(1, rb["pa"] * (1 - rb["k"] - rb["bb"] - rb["hbp"] - rb["hr"])),
        }
    return out


# ---------------------------------------------------------------- ratings
REG_BAT = {"k": 120, "bb": 150, "hbp": 300, "hr": 250, "b1": 400, "b2": 500, "b3": 500}
REG_PIT = {"k": 75, "bb": 110, "hbp": 300, "hr": 400, "b1": 900, "b2": 900, "b3": 900}


def totals(acc, fields):
    s, n, g = acc
    return {f: (s[i] or 0) for i, f in enumerate(fields)}, {f: n[i] for i, f in enumerate(fields)}, g


def blend(cur, prev, w=0.5):
    if not prev:
        return cur
    return {k: cur[k] + w * prev[k] for k in cur}


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def batting_rating(rec, lg, is_pitcher):
    base = lg["pit"] if is_pitcher else lg["pos"]
    if "B" not in rec:
        return {k: base[k] for k in RATE_KEYS}, None, 35 if is_pitcher else 45, 50, 45, 0
    t, n, g = totals(rec["B"], BAT)
    prev = totals(rec["B0"], BAT)[0] if "B0" in rec else None
    use = blend(t, prev) if t["pa"] < 250 and prev else t
    r = bat_rates(use)
    known = {"k": n["k"], "bb": n["w"], "hbp": n["hbp"]}
    out = {}
    for k in RATE_KEYS:
        pa = r["pa"]
        if k in known and known[k] == 0:
            out[k] = base[k]
            continue
        c = REG_BAT[k] * (2.0 if is_pitcher else 1.0)
        out[k] = (r[k] * pa + base[k] * c) / (pa + c)
    # display line from actual season totals
    pa = t["pa"] or 0
    ab = max(1, t["ab"])
    hits = t["h"]
    tb = hits + t["d"] + 2 * t["t"] + 3 * t["hr"]
    obp_den = max(1, t["ab"] + t["w"] + t["hbp"] + t["sf"])
    line = [round(hits / ab, 3), round((hits + t["w"] + t["hbp"]) / obp_den, 3), round(tb / ab, 3),
            t["hr"], t["rbi"], t["sb"], pa]
    # speed: steal attempts, triples share, runs per time on base, double plays
    on = max(1, hits - t["d"] - t["t"] - t["hr"] + t["w"] + t["hbp"])
    z = 0.0
    if n["sb"]:
        z += 0.45 * (((t["sb"] + t["cs"]) / on) - lg["sbatt"]) / 0.06
    z += 0.25 * ((t["t"] / max(1, t["d"] + t["t"])) - lg["tri"]) / 0.08
    z += 0.20 * (((t["r"] - t["hr"]) / max(1, hits + t["w"] + t["hbp"] - t["hr"])) - lg["run"]) / 0.07
    if n["gdp"]:
        z -= 0.10 * ((t["gdp"] / max(1, pa)) - lg["gdp"]) / 0.012
    w = pa / (pa + 200)
    speed = clamp(50 + 17 * z * w, 22, 80) if not is_pitcher else clamp(38 + 10 * z * w, 25, 60)
    att = t["sb"] + t["cs"]
    steal = (t["sb"] + 8 * lg["sbpct"]) / (att + 8) if n["cs"] else lg["sbpct"]
    shr = t["sh"] / max(1, pa)
    bunt = clamp(46 + 9 * (shr - lg["sh"]) / max(0.004, lg["sh"]) + 0.3 * (speed - 50), 30, 75)
    if is_pitcher:
        bunt = 52
    return out, line, round(speed), round(steal, 3), round(bunt), att


def pitching_rating(rec, lg):
    base = lg["all"]
    t, n, g = totals(rec["P"], PIT)
    prev = totals(rec["P0"], PIT)[0] if "P0" in rec else None
    use = blend(t, prev) if t["bfp"] < 200 and prev else t
    bf = max(1, use["bfp"] - use["iw"] - use["sh"])
    singles = use["h"] - use["d"] - use["t"] - use["hr"]
    raw = {"k": use["k"] / bf, "bb": (use["w"] - use["iw"]) / bf, "hbp": use["hbp"] / bf,
           "hr": use["hr"] / bf, "b1": singles / bf, "b2": use["d"] / bf, "b3": use["t"] / bf}
    if n["d"] == 0:  # doubles/triples allowed not recorded: use league shares of hits
        h = max(1, use["h"] - use["hr"])
        share2 = base["b2"] / (base["b1"] + base["b2"] + base["b3"])
        share3 = base["b3"] / (base["b1"] + base["b2"] + base["b3"])
        raw["b2"], raw["b3"] = h * share2 / bf, h * share3 / bf
        raw["b1"] = h * (1 - share2 - share3) / bf
    out = {}
    for k in RATE_KEYS:
        if k == "k" and n["k"] == 0:
            out[k] = base[k]
            continue
        c = REG_PIT[k]
        out[k] = (raw[k] * bf + base[k] * c) / (bf + c)
    gms = max(1, g)
    gs = t["gs"]
    starter = gs * 2 >= gms
    closer = t["save"] >= 12 or (t["save"] >= 6 and t["gf"] >= 0.55 * gms and not starter)
    role = "SP" if starter else ("CL" if closer else "RP")
    bf_per = t["bfp"] / gms
    stam = clamp(bf_per * 3.85 * (1.1 if starter else 1.25), 18, 135)
    ip = t["ipouts"] / 3
    era = (t["er"] * 27 / t["ipouts"]) if t["ipouts"] else 0
    line = [t["win"], t["loss"], round(era, 2), t["save"], round(ip, 1), t["k"], t["w"], gms, gs]
    stuff = clamp(50 + 42 * (out["k"] / base["k"] - 1), 20, 80)
    control = clamp(50 + 30 * (1 - out["bb"] / base["bb"]), 20, 80)
    return out, role, round(stam), line, round(stuff), round(control)


# Signature pitches for famous arms (matched by name + era)
ARSENAL_OVERRIDES = {
    ("Mariano Rivera", 1995): [["FC", 85], ["FF", 15]],
    ("Dennis Eckersley", 1975): [["FF", 50], ["SL", 45], ["CH", 5]],
    ("Trevor Hoffman", 1993): [["FF", 40], ["CH", 50], ["SL", 10]],
    ("Bruce Sutter", 1976): [["FS", 70], ["FF", 30]],
    ("Mike Scott", 1979): [["FS", 45], ["FF", 45], ["CU", 10]],
    ("Tug McGraw", 1965): [["SC", 45], ["FF", 45], ["CU", 10]],
    ("Fernando Valenzuela", 1980): [["SC", 40], ["FF", 35], ["CU", 15], ["SL", 10]],
    ("Carl Hubbell", 1928): [["SC", 50], ["FF", 35], ["CU", 15]],
    ("Christy Mathewson", 1900): [["FF", 50], ["CU", 25], ["SC", 25]],
    ("Hoyt Wilhelm", 1952): [["KN", 85], ["FF", 15]],
    ("Tim Wakefield", 1992): [["KN", 85], ["FF", 10], ["CU", 5]],
    ("Phil Niekro", 1964): [["KN", 80], ["FF", 15], ["SL", 5]],
    ("R.A. Dickey", 2001): [["KN", 85], ["FF", 15]],
    ("Sandy Koufax", 1955): [["FF", 60], ["CU", 35], ["CH", 5]],
    ("Bob Gibson", 1959): [["FF", 55], ["SL", 35], ["CU", 10]],
    ("Brad Lidge", 2002): [["FF", 45], ["SL", 55]],
    ("Kenley Jansen", 2010): [["FC", 85], ["SL", 10], ["SI", 5]],
    ("Aroldis Chapman", 2010): [["FF", 75], ["SL", 20], ["SI", 5]],
    ("Craig Kimbrel", 2010): [["FF", 65], ["KC", 35]],
    ("Madison Bumgarner", 2009): [["FC", 40], ["FF", 30], ["CU", 20], ["CH", 10]],
    ("Clayton Kershaw", 2008): [["FF", 45], ["SL", 35], ["CU", 15], ["CH", 5]],
    ("Pedro Martinez", 1992): [["FF", 50], ["CH", 30], ["CU", 20]],
    ("Greg Maddux", 1986): [["SI", 45], ["FC", 25], ["CH", 25], ["CU", 5]],
    ("Tom Glavine", 1987): [["FF", 45], ["CH", 40], ["CU", 10], ["SL", 5]],
    ("John Smoltz", 1988): [["FF", 45], ["SL", 35], ["FS", 15], ["CU", 5]],
    ("Randy Johnson", 1988): [["FF", 55], ["SL", 40], ["FS", 5]],
    ("Curt Schilling", 1988): [["FF", 55], ["FS", 30], ["SL", 10], ["CU", 5]],
    ("Roger Clemens", 1984): [["FF", 50], ["FS", 30], ["SL", 15], ["CU", 5]],
    ("Josh Beckett", 2001): [["FF", 55], ["CU", 30], ["CH", 15]],
    ("Mitch Williams", 1986): [["FF", 65], ["SL", 35]],
    ("Goose Gossage", 1972): [["FF", 80], ["SL", 20]],
    ("Rollie Fingers", 1968): [["FF", 50], ["SL", 45], ["FS", 5]],
    ("Dan Quisenberry", 1979): [["SI", 85], ["CH", 15]],
    ("Kent Tekulve", 1974): [["SI", 85], ["SL", 15]],
    ("Koji Uehara", 2009): [["FS", 55], ["FF", 45]],
    ("Zach Britton", 2011): [["SI", 90], ["SL", 10]],
    ("Wade Davis", 2009): [["FC", 45], ["FF", 35], ["KC", 20]],
    ("Andrew Miller", 2006): [["SL", 60], ["FF", 40]],
    ("Josh Hader", 2017): [["FF", 75], ["SL", 25]],
    ("Mike Mussina", 1991): [["FF", 45], ["KC", 30], ["CH", 25]],
    ("Justin Verlander", 2005): [["FF", 55], ["SL", 20], ["CU", 20], ["CH", 5]],
    ("Max Scherzer", 2008): [["FF", 50], ["SL", 25], ["CH", 15], ["CU", 10]],
    ("Gerrit Cole", 2013): [["FF", 55], ["SL", 25], ["CU", 10], ["CH", 10]],
    ("Jonathan Papelbon", 2005): [["FF", 70], ["FS", 20], ["SL", 10]],
    ("Eric Gagne", 1999): [["FF", 45], ["CH", 40], ["CU", 15]],
    ("Jose Mesa", 1987): [["FF", 70], ["SL", 20], ["FS", 10]],
    ("Duane Ward", 1986): [["FF", 50], ["SL", 50]],
    ("Tom Henke", 1982): [["FF", 60], ["FS", 40]],
    ("Jeff Reardon", 1979): [["FF", 65], ["CU", 35]],
    ("Dwight Gooden", 1984): [["FF", 60], ["CU", 35], ["CH", 5]],
    ("Orel Hershiser", 1983): [["SI", 55], ["CU", 30], ["CH", 15]],
    ("Jack Morris", 1977): [["FF", 50], ["FS", 30], ["SL", 15], ["CU", 5]],
    ("Walter Johnson", 1907): [["FF", 90], ["CU", 10]],
    ("Grover Cleveland Alexander", 1911): [["FF", 55], ["CU", 45]],
    ("Mordecai Brown", 1903): [["CU", 55], ["FF", 45]],
    ("Shohei Ohtani", 2018): [["FF", 45], ["SL", 30], ["FS", 15], ["CU", 10]],
    ("Yoshinobu Yamamoto", 2024): [["FF", 40], ["FS", 30], ["CU", 25], ["FC", 5]],
}


def arsenal(pid, name, debut, season, role, stuff, t_hand):
    key = None
    for (nm, yr), ars in ARSENAL_OVERRIDES.items():
        if nm == name and debut and abs(int(str(debut)[:4]) - yr) <= 2:
            key = ars
            break
    if key:
        pitches = [list(x) for x in key]
    else:
        r1, r2, r3 = h01(pid + "a"), h01(pid + "b"), h01(pid + "c")
        fb = "SI" if r3 < 0.18 and season >= 1950 else "FF"
        if season < 1950:
            second = "CU"
            third = "CH" if role == "SP" else None
        elif season < 1980:
            second = "SL" if r1 < 0.5 else "CU"
            third = ("CH" if r2 < 0.7 else "SL") if role == "SP" else (None if r2 < 0.6 else "CH")
        elif season < 2000:
            second = "SL" if r1 < 0.62 else ("CU" if r1 < 0.85 else "FS")
            third = ("CH" if r2 < 0.65 else "CU") if role == "SP" else ("FS" if r2 < 0.25 else None)
        else:
            second = "SL" if r1 < 0.55 else ("CU" if r1 < 0.75 else ("FC" if r1 < 0.9 else "CH"))
            third = ("CH" if r2 < 0.6 else ("CU" if r2 < 0.8 else "FC")) if role == "SP" else (
                "CH" if r2 < 0.35 else ("FS" if r2 < 0.5 else None))
        if third == second:
            third = None
        if role == "SP":
            pitches = [[fb, 52], [second, 30]] + ([[third, 18]] if third else [])
        else:
            pitches = [[fb, 60], [second, 40 if not third else 28]] + ([[third, 12]] if third else [])
    # quality per pitch: primary pitches near stuff, others a bit below
    out = []
    for i, (t, use) in enumerate(sorted(pitches, key=lambda x: -x[1])):
        q = stuff + (4 if i == 0 else -3 * i) + round((h01(pid + t) - 0.5) * 8)
        if t == "KN":
            q = max(q, 55)
        out.append([t, use, int(clamp(q, 25, 80))])
    return out


def defense(rec, lg, season):
    """Defense rating by position (2-9) plus arm, eligibility from games played."""
    posg = rec.get("pos") or {}
    games = {2: posg.get("c", 0), 3: posg.get("1b", 0), 4: posg.get("2b", 0), 5: posg.get("3b", 0),
             6: posg.get("ss", 0), 7: posg.get("lf", 0), 8: posg.get("cf", 0), 9: posg.get("rf", 0)}
    of = posg.get("of", 0)
    if of and not (games[7] or games[8] or games[9]):
        games[7] = games[8] = games[9] = of
    fl = rec.get("F", {})
    out = {}
    arm = 50
    for pos in range(2, 10):
        f = fl.get(str(pos))
        lgp = lg["fld"].get(pos) or lg["fld"].get(str(pos))
        if not games[pos] and not f:
            continue
        rating = 50.0
        if f and lgp and f[0] > 0:
            ifouts, po, a, e = f[0], f[1], f[2], f[3]
            ch = po + a
            rf = ch * 27 / ifouts
            fp = ch / max(1, ch + e)
            w = ifouts / (ifouts + 1200)
            if pos == 2:
                raw = 50 + 300 * (fp - lgp["fp"])
                sb, cs = f[6], f[7]
                if sb + cs > 0:
                    arm = 50 + 110 * ((cs / (sb + cs)) - lgp["cs"]) * (sb + cs) / (sb + cs + 60)
            elif pos == 3:
                raw = 50 + 260 * (fp - lgp["fp"]) + 25 * ((a * 27 / ifouts) / max(0.1, lgp["a"]) - 1) * 0.3
            else:
                raw = 50 + 70 * (rf / lgp["rf"] - 1) + 400 * (fp - lgp["fp"])
                if pos >= 7:
                    arm = 50 + 12 * ((a * 27 / ifouts) / max(0.01, lgp["a"]) - 1) * w
            rating = 50 + w * (raw - 50)
        out[pos] = int(clamp(round(rating), 28, 80))
    prim = max(games, key=lambda p: games[p]) if any(games.values()) else None
    return out, prim, int(clamp(round(arm), 30, 75))


# ---------------------------------------------------------------- scenarios
def series_text(g, names):
    wv, wh = g["wins_before"]
    n = g["series_len"]
    if n == 1:
        return "Winner advances" if g["gametype"] != "playoff" else "Winner takes the pennant"
    if wv == wh:
        return f"Series tied {wv}-{wh}" if wv else "Series opener"
    lead, trail = (0, 1) if wv > wh else (1, 0)
    a, b = max(wv, wh), min(wv, wh)
    return f"{names[lead]} lead {a}-{b}"


def event_label(g):
    s = g["season"]
    lgname = league_of(g["home"], s)
    gt = g["gametype"]
    if gt == "worldseries":
        ev = "World Series"
    elif gt == "lcs":
        ev = f"{lgname}CS"
    elif gt == "divisionseries":
        ev = f"{lgname}DS"
    elif gt == "wildcard":
        ev = f"{lgname} Wild Card " + ("Game" if g["series_len"] == 1 else "Series")
    else:
        ev = f"{lgname} Tiebreaker"
    if g["series_len"] == 1:
        return f"{s} {ev}"
    return f"{s} {ev} · Game {g['game_no']}"


def stakes(g, names):
    wv, wh = g["wins_before"]
    need = g["need"]
    if g["series_len"] == 1 or (wv == need - 1 and wh == need - 1):
        return "Winner-take-all"
    if wv == need - 1 and wh < need - 1:
        return f"{names[1]} facing elimination"
    if wh == need - 1 and wv < need - 1:
        return f"{names[0]} facing elimination"
    return ""


def compact_hist(h):
    out = {"i": h["i"], "h": h["h"], "b": h["b"], "p": h["p"], "lp": h["lp"], "ev": h["ev"],
           "seq": h["seq"], "n": h["n"], "pa": 1 if h["pa"] else 0, "o0": h["o0"], "o1": h["o1"],
           "r0": h["r0"], "r1": h["r1"], "s0": h["s0"], "s1": h["s1"], "t": h["txt"], "we": h["we"], "dwe": h["dwe"]}
    if h["subs"]:
        out["subs"] = [{k: v for k, v in s.items() if v is not None} for s in h["subs"]]
    return out


def main():
    ensure_dirs()
    selected = load_json(f"{BUILD}/selected.json")
    states = load_json(f"{BUILD}/states.json")
    rosters = load_json(f"{BUILD}/rosters.json")
    raw = load_json(f"{BUILD}/ratings_raw.json")
    league = build_league(load_json(f"{BUILD}/league.json"))
    people = load_people()
    teams = load_teams()
    mgrs = load_managers()
    parks = load_parks()
    debut = {}
    from common import raw_path, read_csv
    for r in read_csv(raw_path("biodata", "biofile0.csv")):
        debut[r["id"]] = r["debut_p"] or r["debut_c"]
    legend_by_key = {(lg["season"], lg["round"], lg["game"], lg["home"]): lg for lg in LEGENDS}

    players = {}

    def player(pid, season):
        key = f"{pid}:{season}"
        if key in players:
            return key
        rec = raw.get(key, {})
        lg = league.get(season) or league[max(league)]
        ppl = people.get(pid, {"n": pid, "last": pid, "b": "R", "t": "R"})
        is_p = "P" in rec and (not rec.get("pos") or rec["pos"].get("p", 0) * 2 >= max(1, rec.get("g", 1)))
        hr, line, spd, stl, bnt, att = batting_rating(rec, lg, is_p)
        d, prim, arm = defense(rec, lg, season)
        out = {"n": ppl["n"], "l": ppl["last"], "b": rec.get("bat") or ppl["b"] or "R",
               "t": rec.get("throw") or ppl["t"] or "R",
               "h": [round(hr[k], 4) for k in RATE_KEYS], "spd": spd, "stl": stl, "bnt": bnt,
               "d": d, "arm": arm}
        if prim:
            out["pr"] = prim
        if line:
            out["bl"] = line
        if ppl.get("hof"):
            out["hof"] = 1
        if "P" in rec:
            pr, role, stam, pline, stuff, ctl = pitching_rating(rec, lg)
            out["p"] = {"r": [round(pr[k], 4) for k in RATE_KEYS], "role": role, "stam": stam,
                        "ars": arsenal(pid, ppl["n"], debut.get(pid), season, role, stuff, out["t"]),
                        "stf": stuff, "ctl": ctl, "pl": pline}
            out["d"][1] = 50
        players[key] = out
        return key

    index = []
    shards = defaultdict(lambda: {"scenarios": {}, "players": {}, "league": {}})
    for g in selected:
        gid, season = g["gid"], g["season"]
        st = states[gid]
        date = g["date"]
        names, cities = [], []
        team_objs = []
        for side, code in ((0, g["vis"]), (1, g["home"])):
            city, nick = team_name(teams, code, date)
            names.append(nick or city)
            mgr = (g.get("mgr") or [None, None])[side]
            team_objs.append({"code": code, "city": city, "nick": nick or city,
                              "mgr": mgrs.get(mgr, ""), "lg": league_of(code, season)})
        lg = legend_by_key.get((season, g["gametype"], g["game_no"], g["home"]))
        s9 = g["score9"]
        diff = s9[1] - s9[0]
        default_side = 1 if diff <= 0 else 0
        if lg and lg.get("side") is not None:
            default_side = lg["side"]
        series = series_text(g, names)
        stake = stakes(g, names)
        event = event_label(g)
        if lg:
            title, intro = lg["title"], lg["intro"]
        else:
            title = f"{names[0]} at {names[1]}"
            lead = "tied" if diff == 0 else (f"{names[1] if diff > 0 else names[0]} lead {max(s9)}-{min(s9)}")
            intro = f"{event}. {lead[0].upper() + lead[1:]} going to the ninth. {series}."
            if stake:
                intro += f" {stake}."
        # players used
        pkeys = set()
        for side in (0, 1):
            for pid, _ in st["start"]["lineups"][side]:
                pkeys.add(player(pid, season))
            if st["start"]["pitchers"][side]:
                pkeys.add(player(st["start"]["pitchers"][side], season))
            for e in rosters[gid][side]:
                pkeys.add(player(e["p"], season))
        for h in st["history"]:
            pkeys.add(player(h["b"], season))
            pkeys.add(player(h["p"], season))
            for sub in h["subs"]:
                pkeys.add(player(sub["in"], season))
        rules = {"dh": g["usedh"], "season": season, "ghost": False,
                 "three": season >= 2020, "shift": season < 2023, "replay": season >= 2014,
                 "autoIBB": season >= 2017, "bigBases": season >= 2023, "limitPO": season >= 2023,
                 "visits": season >= 2018}
        line = [g["line"][0][:8], g["line"][1][:8]]
        start = dict(st["start"])
        start["pcount"] = {k: v for k, v in start["pcount"].items()}
        sc = {
            "id": gid, "rank": g["rank"], "legend": 1 if lg else 0, "title": title, "intro": intro,
            "event": event, "round": g["gametype"], "gameNo": g["game_no"], "date": date,
            "park": parks.get(g["site"], ""), "series": series, "stakes": stake,
            "seriesLen": g["series_len"], "wins": g["wins_before"],
            "teams": team_objs, "rules": rules, "line": line, "score9": s9,
            "final": g["final"], "innings": g["max_inning"], "side": default_side,
            "start": start, "roster": rosters[gid], "history": [compact_hist(h) for h in st["history"]],
            "starts": st["starts"], "attendance": g.get("attendance", 0), "daynight": g.get("daynight", ""),
        }
        decade = season // 10 * 10
        shard = shards[decade]
        shard["scenarios"][gid] = sc
        for k in pkeys:
            shard["players"][k] = players[k]
        shard["league"][str(season)] = league.get(season) or league[max(league)]
        we_lead = "tied" if diff == 0 else ("up" if (diff > 0) == (default_side == 1) else "down")
        index.append({
            "id": gid, "rank": g["rank"], "legend": 1 if lg else 0, "title": title,
            "event": event, "date": date, "season": season, "round": g["gametype"],
            "teams": [t["nick"] for t in team_objs], "codes": [g["vis"], g["home"]],
            "s9": s9, "final": g["final"], "side": default_side, "sit": we_lead,
            "margin": abs(diff), "shard": f"s-{decade}.json", "stakes": stake,
            "inn": g["max_inning"], "intro": intro,
        })
    index.sort(key=lambda r: r["rank"])
    save_json(os.path.join(WEB_DATA, "index.json"), index)
    for decade, shard in shards.items():
        save_json(os.path.join(WEB_DATA, f"s-{decade}.json"), shard)
    sizes = {f: os.path.getsize(os.path.join(WEB_DATA, f)) for f in os.listdir(WEB_DATA)}
    log("wrote", len(index), "scenarios;", len(players), "player-seasons")
    log("sizes KB", {k: v // 1024 for k, v in sorted(sizes.items())})


if __name__ == "__main__":
    main()
