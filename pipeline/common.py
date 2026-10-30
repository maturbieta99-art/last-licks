"""Shared loaders and constants for the Last Licks data pipeline.

All inputs are Retrosheet CSV exports under raw/<set>/x/. Run scripts from the
project root with `python -I pipeline/<script>.py`.
"""
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
BUILD = os.path.join(ROOT, "build")
WEB_DATA = os.path.join(ROOT, "web", "data")

csv.field_size_limit(10_000_000)

MLB_POST_TYPES = ("worldseries", "lcs", "divisionseries", "wildcard")
ROUND_LABEL = {
    "worldseries": "World Series",
    "lcs": "LCS",
    "divisionseries": "Division Series",
    "wildcard": "Wild Card",
    "playoff": "Tiebreaker",
}


def raw_path(dataset, name):
    return os.path.join(RAW, dataset, "x", name)


def read_csv(path):
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        yield from csv.DictReader(f)


def ensure_dirs():
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(WEB_DATA, exist_ok=True)


def save_json(path, obj, compact=True):
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def series_length(season, gametype, teams):
    """Best-of-N for a series. Single-game rounds return 1."""
    s = int(season)
    if gametype == "worldseries":
        return 9 if s in (1903, 1919, 1920, 1921) else 7
    if gametype == "lcs":
        return 5 if s <= 1984 else 7
    if gametype == "divisionseries":
        return 5
    if gametype == "wildcard":
        if s == 2020 or s >= 2022:
            return 3
        return 1
    if gametype == "playoff":
        # NL used best-of-three playoffs in 1946, 1951, 1959, 1962.
        return 3 if s in (1946, 1951, 1959, 1962) else 1
    return 7


def load_teams():
    """team code -> list of (first_g, last_g, city, nickname)."""
    out = {}
    for r in read_csv(raw_path("biodata", "teams0.csv")):
        out.setdefault(r["team"], []).append(
            (to_int(r["first_g"]), to_int(r["last_g"]), r["city"], r["nickname"]))
    return out


def team_name(teams, code, date):
    rows = teams.get(code, [])
    d = to_int(date)
    for first, last, city, nick in rows:
        if first <= d <= last:
            return city, nick
    if rows:
        return rows[-1][2], rows[-1][3]
    return code, ""


def load_people():
    """retro id -> dict(name, bats, throws, hof)."""
    out = {}
    for r in read_csv(raw_path("biodata", "biofile0.csv")):
        first = r["usename"] or ""
        last = r["lastname"] or ""
        out[r["id"]] = {
            "n": (first + " " + last).strip(),
            "last": last,
            "b": r["bats"] or "R",
            "t": r["throws"] or "R",
            "hof": r["HOF"] == "HOF",
            "ht": to_int(r["height"]),
        }
    return out


def load_managers():
    out = {}
    for r in read_csv(raw_path("biodata", "managers0.csv")):
        out[r["id"]] = (r["firstname"] + " " + r["lastname"]).strip()
    return out


def load_parks():
    out = {}
    for r in read_csv(raw_path("biodata", "ballparks0.csv")):
        out[r["site"]] = r["name"]
    return out


def log(*a):
    print(*a, file=sys.stderr, flush=True)
