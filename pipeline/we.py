"""Generic late-inning win expectancy for ranking scenarios.

A league-average Markov chain gives the run distribution of a half-inning from
any (outs, bases) state; win expectancy for the 9th inning and later follows from
those distributions. This is only used to rank and to find key moments; the game
engine has its own player-specific model.
"""
from functools import lru_cache

MAXR = 16
# League-average plate appearance outcomes (roughly 1990-2019 averages).
PA = {
    "K": 0.185, "BB": 0.095, "1B": 0.155, "2B": 0.046, "3B": 0.006, "HR": 0.028,
    "GO": 0.245, "FO": 0.200, "E": 0.012, "SH": 0.0,  # GO ground out, FO air out
}
_tot = sum(PA.values())
PA = {k: v / _tot for k, v in PA.items()}


def _bits(b):
    return [(b >> i) & 1 for i in range(3)]


def transitions(outs, bases):
    """List of (prob, new_outs, new_bases, runs) for one PA from (outs, bases)."""
    r1, r2, r3 = _bits(bases)
    out = []

    def add(p, o, b1, b2, b3, runs):
        if p > 0:
            out.append((p, o, b1 | (b2 << 1) | (b3 << 2), runs))

    # Strikeout
    add(PA["K"], outs + 1, r1, r2, r3, 0)
    # Walk / HBP: forced advances only
    p = PA["BB"]
    if r1:
        if r2:
            if r3:
                add(p, outs, 1, 1, 1, 1)
            else:
                add(p, outs, 1, 1, 1, 0)
        else:
            add(p, outs, 1, 1, r3, 0)
    else:
        add(p, outs, 1, r2, r3, 0)
    # Error: treat like a single with runners advancing one base
    p = PA["E"]
    add(p, outs, 1, r1, r2, r3)
    # Single: runner on 3rd scores; runner on 2nd scores 60% (2 outs 85%);
    # runner on 1st to 3rd 28%.
    p = PA["1B"]
    s2 = 0.85 if outs == 2 else 0.60
    f3 = 0.28
    for a2, pa2 in ((1, s2), (0, 1 - s2)) if r2 else ((0, 1.0),):
        for a1, pa1 in ((1, f3), (0, 1 - f3)) if r1 else ((0, 1.0),):
            runs = r3 + (1 if (r2 and a2) else 0)
            nb3 = (1 if (r2 and not a2) else 0) | (1 if (r1 and a1) else 0)
            nb2 = 1 if (r1 and not a1) else 0
            add(p * pa2 * pa1, outs, 1, nb2, nb3, runs)
    # Double: runners on 2nd/3rd score; runner on 1st scores 42% (2 outs 60%)
    p = PA["2B"]
    sc1 = 0.60 if outs == 2 else 0.42
    for a1, pa1 in ((1, sc1), (0, 1 - sc1)) if r1 else ((0, 1.0),):
        runs = r3 + r2 + (1 if (r1 and a1) else 0)
        add(p * pa1, outs, 0, 1, 1 if (r1 and not a1) else 0, runs)
    # Triple / homer
    add(PA["3B"], outs, 0, 0, 1, r1 + r2 + r3)
    add(PA["HR"], outs, 0, 0, 0, r1 + r2 + r3 + 1)
    # Ground out
    p = PA["GO"]
    if outs < 2 and r1:
        dp = 0.42
        # double play: batter and runner from first out, others advance one
        runs = r3 if outs == 0 else 0  # run scores on DP only with 0 outs
        if outs + 2 >= 3:
            add(p * dp, 3, 0, 0, 0, 0)
        else:
            add(p * dp, outs + 2, 0, 0, r2, runs)
        # force at second, batter safe at first, others advance
        add(p * (1 - dp), outs + 1, 1, 0, r2, r3)
    else:
        # batter out; runners on 2nd/3rd advance half the time with < 2 outs
        if outs < 2 and (r2 or r3):
            add(p * 0.55, outs + 1, r1, 0, r2, r3)
            add(p * 0.45, outs + 1, r1, r2, r3, 0)
        else:
            add(p, outs + 1, r1, r2, r3, 0)
    # Fly / line / pop out: sac fly from third 55% with < 2 outs
    p = PA["FO"]
    if outs < 2 and r3:
        add(p * 0.55, outs + 1, r1, r2, 0, 1)
        add(p * 0.45, outs + 1, r1, r2, r3, 0)
    else:
        add(p, outs + 1, r1, r2, r3, 0)
    return out


@lru_cache(maxsize=None)
def run_dist(outs, bases):
    """Probability of scoring exactly r more runs in the half inning."""
    dist = [0.0] * MAXR
    mass = {(outs, bases, 0): 1.0}
    for _ in range(40):
        nxt = {}
        for (o, b, r), m in mass.items():
            for p, no, nb, runs in transitions(o, b):
                nr = min(r + runs, MAXR - 1)
                if no >= 3:
                    dist[nr] += m * p
                else:
                    key = (no, nb, nr)
                    nxt[key] = nxt.get(key, 0.0) + m * p
        mass = nxt
        if not mass:
            break
    # leftover mass (negligible) counts as no more runs
    for (o, b, r), m in mass.items():
        dist[r] += m
    return tuple(dist)


def _tail(dist, k):
    """P(runs > k)."""
    return sum(dist[k + 1:]) if k + 1 < len(dist) else 0.0


@lru_cache(maxsize=None)
def _extra_top_tied():
    p0 = run_dist(0, 0)
    a = sum(p0[r] * _tail(p0, r) for r in range(MAXR))
    b = sum(p0[r] * p0[r] for r in range(MAXR))
    return a / (1 - b)


def we_bottom_start(diff):
    """Home WE at the start of the bottom of the 9th+ with diff = home - away."""
    if diff > 0:
        return 1.0
    p0 = run_dist(0, 0)
    need = -diff
    return _tail(p0, need) + (p0[need] if need < MAXR else 0) * _extra_top_tied()


def home_we(half, outs, bases, diff):
    """Home team win expectancy in the 9th or later.

    half 0 = top (away batting), 1 = bottom. diff = home - away before the play.
    """
    if outs >= 3:
        raise ValueError("state must have < 3 outs")
    d = run_dist(outs, bases)
    if half == 0:
        return sum(d[r] * we_bottom_start(diff - r) for r in range(MAXR))
    if diff > 0:
        return 1.0
    need = -diff
    tie = d[need] if need < MAXR else 0.0
    return _tail(d, need) + tie * _extra_top_tied()


def home_we_after_half(half, diff):
    """WE when a half inning has just ended (3 outs) with diff = home - away."""
    if half == 0:
        return we_bottom_start(diff)
    if diff > 0:
        return 1.0
    if diff < 0:
        return 0.0
    return _extra_top_tied()


if __name__ == "__main__":
    print("top 9 tied, none on, 0 out:", round(home_we(0, 0, 0, 0), 3))
    print("bottom 9 tied, 0 out:", round(home_we(1, 0, 0, 0), 3))
    print("bottom 9 down 1, 0 out:", round(home_we(1, 0, 0, -1), 3))
    print("bottom 9 down 1, 2 out, man on 1st:", round(home_we(1, 2, 1, -1), 3))
    print("bottom 9 down 1, 2 out, man on 2nd:", round(home_we(1, 2, 2, -1), 3))
    print("top 9 home up 1:", round(home_we(0, 0, 0, 1), 3))
    print("extra tied top:", round(_extra_top_tied(), 3))
    print("runs/inning:", round(sum(r * p for r, p in enumerate(run_dist(0, 0))), 3))
