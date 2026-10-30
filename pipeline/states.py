"""Step 3: rebuild each selected game's state at the start of the 9th, plus the
real play-by-play from the 9th on.

The lineup tracker replays plays.csv row by row. Each row lists the batting
team's full lineup (l1-l9 with positions lf1-lf9) and the fielding team's
fielders (f2-f9 plus the pitcher), so we always know the batting side exactly and
infer the fielding side's batting slots, looking ahead to their next turn at bat
when a double switch makes it ambiguous.

Output: build/states.json
"""
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import BUILD, load_json, log, raw_path, read_csv, save_json, to_int  # noqa: E402
from we import home_we  # noqa: E402

SETS = ("postseason", "tiebreakers")
PITCH_CHARS = set("BCFHIKLMOPQRSTUVXY")
POS_NAME = {1: "pitcher", 2: "catcher", 3: "first", 4: "second", 5: "third",
            6: "short", 7: "left", 8: "center", 9: "right"}
FIELDER = {1: "pitcher", 2: "catcher", 3: "first baseman", 4: "second baseman",
           5: "third baseman", 6: "shortstop", 7: "left fielder", 8: "center fielder",
           9: "right fielder"}
LOC_WORDS = {
    "7": "left", "8": "center", "9": "right", "78": "left-center", "89": "right-center",
    "1": "the pitcher", "2": "the catcher", "3": "first", "4": "second", "5": "third",
    "6": "short", "56": "the hole at short", "34": "the hole at second", "13": "the right side",
    "15": "the left side", "23": "the right side", "25": "the left side",
}


class Team:
    def __init__(self, slots, pitcher, dh):
        self.slots = slots  # list of [pid, pos]
        self.pitcher = pitcher
        self.dh = dh

    def pids(self):
        return {p for p, _ in self.slots}

    def snapshot(self):
        return copy.deepcopy((self.slots, self.pitcher))


def init_team(ts, dh):
    lineup = [ts[f"start_l{i}"] for i in range(1, 10)]
    by_pos = {i: ts[f"start_f{i}"] for i in range(1, 11)}
    slots = []
    for pid in lineup:
        pos = next((p for p, q in by_pos.items() if q == pid and p != 1), None)
        if pos is None and by_pos.get(1) == pid:
            pos = 1
        slots.append([pid, pos or 10])
    return Team(slots, by_pos[1], dh)


def future_slot(rows, start, team, pid):
    for r in rows[start:]:
        if r["batteam"] == team:
            for i in range(1, 10):
                if r[f"l{i}"] == pid:
                    return i - 1
    return None


def apply_fielding(t, r, rows, idx, team_code):
    """Update fielding team t from row r's pitcher and f2-f9."""
    field = {1: r["pitcher"]}
    for p in range(2, 10):
        if r[f"f{p}"]:
            field[p] = r[f"f{p}"]
    t.pitcher = r["pitcher"]
    on_field = set(field.values())
    # existing players who changed position
    for slot in t.slots:
        pid = slot[0]
        for pos, q in field.items():
            if q == pid and (pos != 1 or not t.dh):
                slot[1] = pos
    newcomers = [(pos, pid) for pos, pid in field.items()
                 if pid not in t.pids() and not (pos == 1 and t.dh)]
    if not newcomers:
        return
    vacated = [i for i, (pid, pos) in enumerate(t.slots)
               if pid not in on_field and pos != 10]
    if len(newcomers) == 1 and len(vacated) == 1:
        pos, pid = newcomers[0]
        t.slots[vacated[0]] = [pid, pos]
        return
    # Ambiguous (double switch): look ahead to the team's next time up
    remaining = list(vacated)
    for pos, pid in newcomers:
        s = future_slot(rows, idx, team_code, pid)
        if s is not None and s in remaining:
            t.slots[s] = [pid, pos]
            remaining.remove(s)
    for pos, pid in newcomers:
        if pid in t.pids():
            continue
        # prefer the vacated slot whose old occupant played the same position
        pick = next((s for s in remaining if t.slots[s][1] == pos), None)
        if pick is None and remaining:
            pick = remaining[0]
        if pick is not None:
            t.slots[pick] = [pid, pos]
            remaining.remove(pick)


def apply_batting(t, r):
    for i in range(1, 10):
        pid, pos = r[f"l{i}"], to_int(r[f"lf{i}"])
        if pid:
            t.slots[i - 1] = [pid, pos]


def diff_subs(before, after, side):
    """Lineup/pitcher changes between two snapshots for one team."""
    (s0, p0), (s1, p1) = before, after
    subs = []
    for i, ((a, apos), (b, bpos)) in enumerate(zip(s0, s1)):
        if a != b:
            kind = {11: "ph", 12: "pr", 1: "pitch"}.get(bpos, "def")
            subs.append({"t": side, "k": kind, "in": b, "out": a, "slot": i, "pos": bpos})
        elif apos != bpos and bpos not in (11, 12):
            subs.append({"t": side, "k": "pos", "in": b, "out": None, "slot": i, "pos": bpos})
    if p1 != p0 and not any(s["in"] == p1 for s in subs):
        subs.append({"t": side, "k": "pitch", "in": p1, "out": p0, "slot": None, "pos": 1})
    elif p1 != p0:
        for s in subs:
            if s["in"] == p1:
                s["k"] = "pitch"
                s["pout"] = p0
    return subs


def nump(r):
    n = to_int(r["nump"], -1)
    if n >= 0:
        return n, False
    seq = r["pitches"]
    if seq:
        return sum(1 for c in seq if c in PITCH_CHARS), False
    return (3.7 if r["pa"] == "1" else 0), True


def name_of(people, pid):
    p = people.get(pid)
    return p["n"] if p else pid


def last_of(people, pid):
    p = people.get(pid)
    return (p["last"] or p["n"]) if p else pid


def loc_words(loc):
    if not loc:
        return ""
    base = loc.rstrip("+-").replace("XD", "").replace("D", "").replace("S", "").replace("M", "")
    base = base.replace("LF", "").replace("L", "").replace("F", "")
    w = LOC_WORDS.get(base)
    deep = "D" in loc and "XD" not in loc
    if not w:
        return ""
    if deep and base in ("7", "8", "9", "78", "89"):
        return " to deep " + w
    return " to " + w


def describe(r, people):
    """Plain-English text for one real play."""
    b = last_of(people, r["batter"])
    ev = r["event"]
    loc = loc_words(r["loc"])
    fielder = POS_NAME.get(to_int(r["firstf"]), "")
    parts = []
    if r["hr"] == "1":
        runners = sum(1 for k in ("br1_pre", "br2_pre", "br3_pre") if r[k])
        parts.append(f"{b} homers{loc}" + (" for a grand slam" if runners == 3 else ""))
    elif r["triple"] == "1":
        parts.append(f"{b} triples{loc}")
    elif r["double"] == "1":
        parts.append(f"{b} doubles{loc}")
    elif r["single"] == "1":
        parts.append(f"{b} singles{loc}")
    elif r["walk"] == "1":
        parts.append(f"{b} is intentionally walked" if r["iw"] == "1" else f"{b} walks")
    elif r["hbp"] == "1":
        parts.append(f"{b} is hit by a pitch")
    elif r["k"] == "1":
        seq = r["pitches"].rstrip(".>*+123")
        looking = seq.endswith("C")
        txt = f"{b} strikes out {'looking' if looking else 'swinging'}"
        if r["k_safe"] == "1":
            txt += " but reaches"
        parts.append(txt)
    elif r["roe"] == "1":
        ef = next((FIELDER[k] for k in range(1, 10) if to_int(r[f"e{k}"]) > 0), None)
        parts.append(f"{b} reaches on an error by the {ef or 'defense'}")
    elif r["xi"] == "1":
        parts.append(f"{b} reaches on catcher's interference")
    elif r["fc"] == "1":
        parts.append(f"{b} reaches on a fielder's choice")
    elif r["sh"] == "1":
        parts.append(f"{b} lays down a sacrifice bunt")
    elif r["sf"] == "1":
        parts.append(f"{b} hits a sacrifice fly{loc}")
    elif r["pa"] == "1":
        ht = r["hittype"]
        dp = r["gdp"] == "1" or r["othdp"] == "1"
        tp = r["tp"] == "1"
        where = f" to {fielder}" if fielder else ""
        if "FL" in ev:
            verb = "fouls out"
        elif ht in ("G", "BG"):
            verb = "grounds into a double play" if dp else "grounds out"
        elif ht == "L":
            verb = "lines into a double play" if dp else "lines out"
        elif ht in ("P", "BP"):
            verb = "pops out"
        elif ht == "F":
            verb = "flies into a double play" if dp else "flies out"
        else:
            verb = "is out"
        if tp:
            verb = "hits into a triple play"
        parts.append(f"{b} {verb}{'' if dp or tp else where}")
    # baserunning events
    for base, key in (("second", "sb2"), ("third", "sb3"), ("home", "sbh")):
        if r[key] == "1":
            runner = r["br1_pre"] if key == "sb2" else (r["br2_pre"] if key == "sb3" else r["br3_pre"])
            parts.append(f"{last_of(people, runner)} steals {base}")
    for base, key, src in (("second", "cs2", "br1_pre"), ("third", "cs3", "br2_pre"), ("home", "csh", "br3_pre")):
        if r[key] == "1":
            parts.append(f"{last_of(people, r[src])} is caught stealing {base}")
    for base, key in (("first", "pko1"), ("second", "pko2"), ("third", "pko3")):
        if r[key] == "1":
            parts.append(f"runner picked off {base}")
    if r["wp"] == "1":
        parts.append("wild pitch")
    if r["pb"] == "1":
        parts.append("passed ball")
    if r["bk"] == "1":
        parts.append("balk")
    if r["di"] == "1":
        parts.append("runner takes the base on defensive indifference")
    scored = [r[k] for k in ("run3", "run2", "run1") if r[k]]
    if r["run_b"] and r["hr"] != "1":
        scored.append(r["run_b"])
    scorers = [last_of(people, p) for p in scored]
    if scorers:
        parts.append((" and ".join(scorers)) + (" scores" if len(scorers) == 1 else " score"))
    if not parts:
        parts.append(ev)
    txt = "; ".join(parts)
    return txt[0].upper() + txt[1:] + "."


def bases(r, suffix):
    return [r[f"br{i}_{suffix}"] or None for i in (1, 2, 3)]


def build_game(g, rows, ts_by_team, people):
    vis, home = g["vis"], g["home"]
    dh = g["usedh"]
    teams = {vis: init_team(ts_by_team[vis], dh), home: init_team(ts_by_team[home], dh)}
    appeared = {vis: teams[vis].pids() | {teams[vis].pitcher}, home: teams[home].pids() | {teams[home].pitcher}}
    he = {vis: [0, 0], home: [0, 0]}  # hits, errors through 8
    pcount = {}  # pid -> [pitches, bf, estimated]
    lines = {}  # pid -> [pa, ab, h, hr, bb, k, rbi]
    start = None
    history = []
    pending_subs = []
    for idx, r in enumerate(rows):
        inn = to_int(r["inning"])
        bt, ft = r["batteam"], r["pitteam"]
        if inn >= 9 and start is None:
            pitchers, removed = [], []
            for code in (vis, home):
                t = teams[code]
                p = t.pitcher
                # a pitcher pinch-hit for (no DH) is out of the game
                if not t.dh and p not in t.pids():
                    p = None
                pitchers.append(p)
                removed.append(sorted(appeared[code] - t.pids() - ({p} if p else set())))
            start = {
                "lineups": [copy.deepcopy(teams[vis].slots), copy.deepcopy(teams[home].slots)],
                "pitchers": pitchers,
                "pcount": copy.deepcopy(pcount),
                "lines": copy.deepcopy(lines),
                "removed": removed,
                "he": [list(he[vis]), list(he[home])],
            }
        before = {vis: teams[vis].snapshot(), home: teams[home].snapshot()}
        apply_batting(teams[bt], r)
        apply_fielding(teams[ft], r, rows, idx + 1, ft)
        subs = []
        for code, side in ((vis, 0), (home, 1)):
            subs += diff_subs(before[code], teams[code].snapshot(), side)
            appeared[code] |= teams[code].pids() | {teams[code].pitcher}
        # Pinch hitters/runners for the DH keep position code 10; classify by role
        on_base = {r["br1_pre"], r["br2_pre"], r["br3_pre"]} - {""}
        for sub in subs:
            if sub["k"] == "def":
                if sub["in"] == r["batter"]:
                    sub["k"] = "ph"
                elif sub["in"] in on_base:
                    sub["k"] = "pr"
        if inn < 9:
            he[bt][0] += sum(to_int(r[k]) for k in ("single", "double", "triple", "hr"))
            he[ft][1] += sum(1 for k in range(1, 10) if to_int(r[f"e{k}"]) > 0)
        # pitch counts and batter lines
        n, est = nump(r)
        pc = pcount.setdefault(r["pitcher"], [0, 0, False])
        pc[0] += n
        pc[2] = pc[2] or est
        if r["pa"] == "1":
            pc[1] += 1
            ln = lines.setdefault(r["batter"], [0, 0, 0, 0, 0, 0, 0])
            ln[0] += 1
            ln[1] += to_int(r["ab"])
            ln[2] += to_int(r["single"]) + to_int(r["double"]) + to_int(r["triple"]) + to_int(r["hr"])
            ln[3] += to_int(r["hr"])
            ln[4] += to_int(r["walk"])
            ln[5] += to_int(r["k"])
            ln[6] += to_int(r["rbi"])
        if inn < 9:
            continue
        if r["event"] == "NP":
            pending_subs += subs
            continue
        sv, sh = to_int(r["score_v"]), to_int(r["score_h"])
        runs = to_int(r["runs"])
        half = to_int(r["top_bot"])
        post = [sv + runs, sh] if half == 0 else [sv, sh + runs]
        history.append({
            "i": inn, "h": half, "b": r["batter"], "p": r["pitcher"], "lp": to_int(r["lp"]) - 1,
            "ev": r["event"], "seq": r["pitches"], "n": n, "pa": r["pa"] == "1",
            "o0": to_int(r["outs_pre"]), "o1": to_int(r["outs_post"]),
            "r0": bases(r, "pre"), "r1": bases(r, "post"), "s0": [sv, sh], "s1": post,
            "subs": pending_subs + subs, "txt": describe(r, people),
            "bf": to_int(r["bat_f"]),
        })
        pending_subs = []
    if start is None or not history:
        return None
    return start, history


def due_slots(rows, history):
    """Lineup slot (0-8) due up first in the 9th for each team."""
    due = [None, None]
    for side in (0, 1):
        first = next((h for h in history if h["h"] == side and h["i"] == 9), None)
        if first:
            due[side] = first["lp"]
    if due[1] is None:
        # Home team never batted in the 9th: next slot after its last 8th-inning PA
        last = None
        for r in rows:
            if to_int(r["inning"]) == 8 and r["top_bot"] == "1" and r["event"] != "NP":
                last = r
        if last is not None:
            lp = to_int(last["lp"]) - 1
            due[1] = (lp + 1) % 9 if last["pa"] == "1" else lp
        else:
            due[1] = 0
    return due


def wp_path(history, final):
    path = []
    for h in history:
        o = min(h["o0"], 2)
        b = sum(1 << i for i, x in enumerate(h["r0"]) if x)
        path.append(home_we(h["h"], o, b, h["s0"][1] - h["s0"][0]))
    path.append(1.0 if final[1] > final[0] else 0.0)
    return path


def key_moment(history, path):
    deltas = [path[i + 1] - path[i] for i in range(len(history))]
    k = max(range(len(deltas)), key=lambda i: abs(deltas[i]))
    # walk back to the first row of that plate appearance
    while k > 0:
        a, b = history[k - 1], history[k]
        if a["i"] == b["i"] and a["h"] == b["h"] and a["lp"] == b["lp"] and not a["pa"]:
            k -= 1
        else:
            break
    return k, deltas


def main():
    from common import load_people
    selected = load_json(f"{BUILD}/selected.json")
    want = {g["gid"]: g for g in selected}
    people = load_people()
    ts = {}
    for ds in SETS:
        for r in read_csv(raw_path(ds, "teamstats.csv")):
            if r["gid"] in want and r["stattype"] == "value":
                ts.setdefault(r["gid"], {})[r["team"]] = r
    rows_by = {}
    for ds in SETS:
        for r in read_csv(raw_path(ds, "plays.csv")):
            if r["gid"] in want:
                rows_by.setdefault(r["gid"], []).append(r)
    out = {}
    bad = 0
    for gid, g in want.items():
        rows = rows_by.get(gid)
        if not rows or gid not in ts:
            log("missing rows", gid)
            bad += 1
            continue
        res = build_game(g, rows, ts[gid], people)
        if not res:
            log("no state", gid)
            bad += 1
            continue
        start, history = res
        start["due"] = due_slots(rows, history)
        path = wp_path(history, g["final"])
        key, deltas = key_moment(history, path)
        for h, d, w in zip(history, deltas, path):
            h["we"] = round(w, 4)
            h["dwe"] = round(d, 4)
        starts = [{"label": "Top of the 9th", "idx": 0}]
        b9 = next((i for i, h in enumerate(history) if h["i"] == 9 and h["h"] == 1), None)
        if b9 is not None:
            starts.append({"label": "Bottom of the 9th", "idx": b9})
        if key not in (0, b9):
            hk = history[key]
            starts.append({"label": "The moment", "idx": key,
                           "who": hk["b"], "inning": hk["i"], "half": hk["h"]})
        out[gid] = {"start": start, "history": history, "starts": starts, "key": key}
    save_json(f"{BUILD}/states.json", out)
    log("states built:", len(out), "failed:", bad)


if __name__ == "__main__":
    main()
