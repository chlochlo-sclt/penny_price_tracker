"""Forecast from a product's price history.

For every past day, look at the next `horizon_days` and ask: did the price fall
at least `drop_threshold` below that day's price? The share of days where it did
is the drop probability, nudged toward same-time-of-year and same-weekday
windows (shrunk toward the overall rate so small samples don't dominate).

Also returned:
- the likely range (and median) of the LOWEST price within the window
- when in the window the low has landed (`likely_low_day`), plus how much that
  timing clusters (`low_day_strength`, 0 = evenly spread) and which half it
  favours (`low_day_half`). The strength matters: on real Amazon data these
  timings are usually spread right across the window, which makes the median
  date the window's midpoint and nothing more.
Output keys match the extension's prediction contract (percent + USD fields).
"""
import numpy as np
import pandas as pd


OUTLIER_HIGH = 1.8          # vs the trailing 60-day median
FLICKER_LOW = 0.55          # suspiciously cheap, but only noise if it doesn't last
FLICKER_HOURS = 12          # a real sale holds longer than this


def clean_outliers(history: pd.DataFrame) -> pd.DataFrame:
    """Drop bogus points such as a $99.99 third-party offer on a $260 item.

    Depth alone can't tell a glitch from a genuine 50%-off sale, so a very low
    point is only dropped when it does NOT last: if the price is still that low
    FLICKER_HOURS later, it is treated as a real discount and kept. Absurdly high
    points are dropped outright. Both tests look only at earlier data plus how
    long a price persisted, never at future prices.
    """
    if len(history) < 5:
        return history
    ts = pd.to_datetime(history["timestamp"], utc=True, format="ISO8601").dt.tz_localize(None)
    order = np.argsort(ts.to_numpy(), kind="stable")
    t = ts.to_numpy()[order]
    price = pd.Series(history["price"].to_numpy(dtype=float)[order], index=t)

    ref = price.rolling("60D", closed="left").median()
    low = price < FLICKER_LOW * ref
    high = price > OUTLIER_HIGH * ref

    # how long each low price held: time until the next point that is NOT low
    p = price.to_numpy()
    lasted = np.zeros(len(p), dtype="timedelta64[ns]")
    for i in np.flatnonzero(low.to_numpy()):
        j = i + 1
        while j < len(p) and p[j] <= p[i] * 1.02:
            j += 1
        lasted[i] = (t[j] if j < len(p) else t[-1]) - t[i]
    flicker = low.to_numpy() & (lasted < np.timedelta64(FLICKER_HOURS, "h"))

    bad = (flicker | high.to_numpy()) & ~ref.isna().to_numpy()
    keep = np.ones(len(history), dtype=bool)
    keep[order] = ~bad
    return history[keep]


def daily_series(history: pd.DataFrame) -> pd.Series:
    history = clean_outliers(history)
    ts = pd.to_datetime(history["timestamp"], utc=True, format="ISO8601").dt.tz_localize(None).dt.normalize()
    s = pd.Series(history["price"].to_numpy(dtype=float), index=ts).sort_index()
    s = s.groupby(level=0).median()         # one price per day (median resists flicker)
    return s.asfreq("D").ffill()            # fill gaps with the last known price


def _shrink(rate, n, prior, k=30):
    return (rate * n + prior * k) / (n + k)


def _confidence(history_days, n_events, has_proven_signal=True):
    """How much to trust the number. "high" needs a long history AND a signal
    (seasonality or price position) that proved itself on this product's own past;
    with only the plain historical rate, the best label is "medium"."""
    if history_days >= 270 and n_events >= 15:
        return "high" if has_proven_signal else "medium"
    if history_days >= 90 and n_events >= 5:
        return "medium"
    return "low"


def history_source(history: pd.DataFrame) -> str:
    sources = set(history["source"].unique())
    if sources == {"simulated"}:
        return "simulated"
    return "mixed" if "simulated" in sources else "real"


USE_STATE = True
STATE_DAYS = 90


def _state_earns_its_keep(ratio, event, horizon):
    """Forward-only check on this product's own history: does a past day's price
    position (vs its 90-day median) predict later drops better than the plain
    rate known at that time? Uses only days that finished before each test day."""
    n = len(event)
    err_s = err_b = 0.0
    count = 0
    for i in range(120, n, 5):
        known = i - horizon                       # outcomes finished by day i
        if known < 90 or np.isnan(ratio[i]):
            continue
        base = float(event[:known].mean())
        sim = ~np.isnan(ratio[:known]) & (np.abs(ratio[:known] - ratio[i]) <= 0.06)
        if sim.sum() < 20:
            continue
        ps = _shrink(float(event[:known][sim].mean()), int(sim.sum()), base, k=40)
        y = float(event[i])
        err_s += (ps - y) ** 2
        err_b += (base - y) ** 2
        count += 1
    return count >= 30 and err_b > 0 and (1 - err_s / err_b) >= SEASON_MIN_GAIN


def _state_adjust(s, p, n, event, p_all, p_hat, price, horizon=14):
    """Condition on where today's price sits versus its own recent level.

    A price well above its 90-day median usually falls back; one already at its
    low has little room. Past days with a similar position give a rate that is
    blended (as an odds ratio vs the overall rate) into the seasonal estimate.
    """
    med = s.rolling(STATE_DAYS, min_periods=30).median().to_numpy()
    ratio = p / med                                  # position of each past day
    cur_med = float(np.median(p[-STATE_DAYS:]))
    r_now = price / cur_med
    if not _state_earns_its_keep(ratio[:n], event, horizon):
        return p_hat, False
    ok = ~np.isnan(ratio[:n])
    for width in (0.03, 0.06, 0.10):
        similar = ok & (np.abs(ratio[:n] - r_now) <= width)
        if similar.sum() >= 40:
            break
    if similar.sum() < 15 or p_all <= 0 or p_all >= 1:
        return p_hat, False
    p_state = _shrink(float(event[similar].mean()), int(similar.sum()), p_all, k=40)
    odds = lambda x: x / (1 - x)
    mixed = odds(min(max(p_hat, 0.01), 0.99)) * odds(min(max(p_state, 0.01), 0.99)) / odds(min(max(p_all, 0.01), 0.99))
    return float(mixed / (1 + mixed)), True


SEASON_MIN_GAIN = 0.03     # seasonality must cut error by 3% to be used


def _season_earns_its_keep(starts, event, p_all):
    """Leave-one-year-out check on this product's own history: do same-time-of-year
    windows from OTHER years predict a year's drops better than the plain rate?
    Needs at least 2 years; otherwise seasonality is not trusted."""
    doy = starts.day_of_year.to_numpy()
    year = starts.year.to_numpy()
    years = np.unique(year)
    if len(years) < 2:
        return False
    err_s = err_b = 0.0
    count = 0
    for i in range(0, len(doy), 5):
        other = year != year[i]
        gap = np.abs(doy - doy[i])
        near = other & (np.minimum(gap, 365 - gap) <= 21)
        if near.sum() < 10 or other.sum() < 60:
            continue
        base = float(event[other].mean())
        ps = _shrink(float(event[near].mean()), int(near.sum()), base)
        y = float(event[i])
        err_s += (ps - y) ** 2
        err_b += (base - y) ** 2
        count += 1
    return count >= 30 and err_b > 0 and (1 - err_s / err_b) >= SEASON_MIN_GAIN


# A calendar date counts as a real sale date only if it is clearly cheaper than
# its own surrounding weeks AND was cheaper in most years we can compare.
CAL_NEIGHBOURHOOD = 21          # +/- days that define the "normal" price
CAL_MIN_BELOW_PCT = 3.0         # must be at least this far below normal
CAL_MIN_YEARS = 3               # need at least this many comparable years
CAL_MIN_SHARE = 0.6             # and cheaper in at least this share of them


def calendar_low_day(s, today, horizon_days):
    """Find a genuine sale DATE in the next horizon_days, or None.

    The window-offset method (below) only asks how far into a window the low
    landed, so an evenly spread set of timings puts the answer at the window's
    midpoint and Black Friday is invisible to it. This asks the calendar
    question instead: on this day-of-year, in past years, was this product
    actually cheaper than it was in the surrounding few weeks?

    Returns {"date", "below_pct", "years_below", "years": n} or None.
    """
    idx = s.index
    years = sorted({int(y) for y in idx.year.unique()})
    best = None
    for k in range(1, horizon_days + 1):
        target = today + pd.Timedelta(days=k)
        rels = []
        for y in years:
            try:
                anchor = target.replace(year=y)
            except ValueError:                       # Feb 29 in a non-leap year
                continue
            if anchor not in s.index:
                continue
            lo = anchor - pd.Timedelta(days=CAL_NEIGHBOURHOOD)
            hi = anchor + pd.Timedelta(days=CAL_NEIGHBOURHOOD)
            near = s[(idx >= lo) & (idx <= hi)]
            if len(near) < 20:
                continue
            base = float(near.median())
            if base > 0:
                rels.append(float(s.loc[anchor]) / base - 1)
        if len(rels) < CAL_MIN_YEARS:
            continue
        below_pct = -float(np.median(rels)) * 100
        years_below = int(sum(1 for r in rels if r < -0.01))
        if below_pct < CAL_MIN_BELOW_PCT:
            continue
        if years_below < max(2, round(CAL_MIN_SHARE * len(rels))):
            continue
        cand = {"date": target.date().isoformat(), "below_pct": round(below_pct, 1),
                "years_below": years_below, "years": len(rels)}
        if best is None or cand["below_pct"] > best["below_pct"]:
            best = cand
    return best


def forecast(history, current_price, horizon_days=14, drop_threshold=0.05, today=None):
    s = daily_series(history)
    today = pd.Timestamp(today if today is not None else pd.Timestamp.today()).normalize()
    price = float(current_price)

    if len(s) < horizon_days + 30:
        return {"p_drop": 0.0, "expected_drop_pct": 0.0, "expected_drop_usd": 0.0,
                "interval_low_usd": price, "interval_high_usd": price,
                "predicted_low_usd": price, "confidence": "low",
                "today": today.date().isoformat(), "likely_low_day": None,
                "low_day_strength": 0.0, "low_day_half": None, "low_day_reason": None,
                "history_days": int(len(s)), "n_events": 0, "enough_data": False}

    p = s.to_numpy()
    n = len(p) - horizon_days
    windows = np.array([p[i + 1:i + 1 + horizon_days] for i in range(n)])
    future_min = windows.min(axis=1)
    low_offset = windows.argmin(axis=1) + 1            # days after the start when the low happens
    drop = future_min / p[:n] - 1                      # e.g. -0.08 = fell 8%
    event = drop <= -drop_threshold
    starts = s.index[:n]

    p_all = float(event.mean())

    gap = np.abs(starts.day_of_year.to_numpy() - today.day_of_year)
    near_season = np.minimum(gap, 365 - gap) <= 21     # same time of year, +/- 3 weeks
    use_season = _season_earns_its_keep(starts, event, p_all)
    if use_season and near_season.any():
        p_hat = _shrink(float(event[near_season].mean()), int(near_season.sum()), p_all)
    else:
        p_hat = p_all

    # Weekday only matters when the deadline is shorter than a week (a longer window
    # contains every weekday). Applied as a gentle multiplier, so it can never
    # override the seasonal estimate above.
    if horizon_days < 7:
        same_dow = starts.day_of_week.to_numpy() == today.day_of_week
        if same_dow.any() and p_all > 0:
            factor = _shrink(float(event[same_dow].mean()), int(same_dow.sum()), p_all) / p_all
            p_hat = min(max(p_hat * min(max(factor, 0.8), 1.25), 0.0), 1.0)

    used_state = False
    if USE_STATE:
        p_hat, used_state = _state_adjust(s, p, n, event, p_all, p_hat, price, horizon_days)

    sizes = -drop[event]                               # drop sizes when a drop happened
    expected_drop = float(sizes.mean()) if len(sizes) else 0.0

    # Lowest price you could pay within the deadline: 10th-90th percentile and median,
    # using same-time-of-year windows when there are enough. Includes windows where
    # nothing dropped, and is capped at today's price because buying now is always possible.
    pool = drop[near_season] if near_season.sum() >= 30 else drop
    low = max(price * (1 + float(np.quantile(pool, 0.1))), 0.0)
    high = min(price * (1 + float(np.quantile(pool, 0.9))), price)
    mid = min(price * (1 + float(np.quantile(pool, 0.5))), price)
    low = min(low, high)

    # When in the window the low has landed, in past windows that actually dropped
    # (same-time-of-year ones when there are enough of them).
    #
    # How much to trust the date depends on whether those timings CLUSTER. Offsets
    # spread evenly across the window put the median at its midpoint, which is a
    # date carrying no information. low_day_strength measures that: the IQR of the
    # offsets against the ~H/2 IQR of an even spread. 0 means flat, 1 means one day.
    # Measured on real data, most products are flat at 14 days and tilt to the
    # second half at 35, so the decision layer words the sentence accordingly.
    season_events = event & near_season
    pick = season_events if season_events.sum() >= 5 else event
    likely_low_day = None
    low_day_strength = 0.0
    low_half = None
    low_day_reason = None
    if pick.sum() >= 3:
        offs = low_offset[pick]
        offset = int(round(float(np.median(offs))))
        likely_low_day = (today + pd.Timedelta(days=offset)).date().isoformat()
        q1, q3 = np.percentile(offs, [25, 75])
        low_day_strength = round(max(0.0, 1 - (q3 - q1) / (horizon_days / 2)), 2)
        half = horizon_days / 2
        later = float((offs > half).mean())
        if later >= 0.6:
            low_half = "late"
        elif later <= 0.4:
            low_half = "early"

    # A real calendar sale date beats the window-offset guess whenever one exists.
    cal = calendar_low_day(s, today, horizon_days)
    if cal:
        likely_low_day = cal["date"]
        low_day_strength = 1.0
        low_half = None
        low_day_reason = cal

    return {
        "p_drop": round(p_hat, 3),
        "expected_drop_pct": round(expected_drop * 100, 1),
        "expected_drop_usd": round(price * expected_drop, 2),
        "interval_low_usd": round(low, 2),
        "interval_high_usd": round(high, 2),
        "predicted_low_usd": round(mid, 2),
        "confidence": _confidence(len(s), int(event.sum()), use_season or used_state),
        "today": today.date().isoformat(),
        "likely_low_day": likely_low_day,
        "low_day_strength": low_day_strength,
        "low_day_half": low_half,
        "low_day_reason": low_day_reason,
        "history_days": int(len(s)),
        "n_events": int(event.sum()),
        "enough_data": True,
    }
