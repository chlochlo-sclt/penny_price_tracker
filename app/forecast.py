"""Forecast from a product's price history.

For every past day, look at the next `horizon_days` and ask: did the price fall
at least `drop_threshold` below that day's price? The share of days where it did
is the drop probability, nudged toward same-time-of-year and same-weekday
windows (shrunk toward the overall rate so small samples don't dominate).

Also returned:
- the likely range (and median) of the LOWEST price within the window
- the most likely day that low happens (`likely_low_day`): in past windows that
  did drop, how many days in the lowest price came. With years of history, the
  same-time-of-year windows pick up Black Friday, Prime Day, etc. by themselves.
Output keys match the extension's prediction contract (percent + USD fields).
"""
import numpy as np
import pandas as pd


def daily_series(history: pd.DataFrame) -> pd.Series:
    ts = pd.to_datetime(history["timestamp"], utc=True, format="ISO8601").dt.tz_localize(None).dt.normalize()
    s = pd.Series(history["price"].to_numpy(dtype=float), index=ts).sort_index()
    s = s.groupby(level=0).last()           # one price per day
    return s.asfreq("D").ffill()            # fill gaps with the last known price


def _shrink(rate, n, prior, k=30):
    return (rate * n + prior * k) / (n + k)


def _confidence(history_days, n_events):
    if history_days >= 270 and n_events >= 15:
        return "high"
    if history_days >= 90 and n_events >= 5:
        return "medium"
    return "low"


def history_source(history: pd.DataFrame) -> str:
    sources = set(history["source"].unique())
    if sources == {"simulated"}:
        return "simulated"
    return "mixed" if "simulated" in sources else "real"


def forecast(history, current_price, horizon_days=14, drop_threshold=0.05, today=None):
    s = daily_series(history)
    today = pd.Timestamp(today if today is not None else pd.Timestamp.today()).normalize()
    price = float(current_price)

    if len(s) < horizon_days + 30:
        return {"p_drop": 0.0, "expected_drop_pct": 0.0, "expected_drop_usd": 0.0,
                "interval_low_usd": price, "interval_high_usd": price,
                "predicted_low_usd": price, "confidence": "low",
                "today": today.date().isoformat(), "likely_low_day": None,
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
    p_season = float(event[near_season].mean()) if near_season.any() else p_all
    p_hat = _shrink(p_season, int(near_season.sum()), p_all)

    # Weekday only matters when the deadline is shorter than a week (a longer window
    # contains every weekday). Applied as a gentle multiplier, so it can never
    # override the seasonal estimate above.
    if horizon_days < 7:
        same_dow = starts.day_of_week.to_numpy() == today.day_of_week
        if same_dow.any() and p_all > 0:
            factor = _shrink(float(event[same_dow].mean()), int(same_dow.sum()), p_all) / p_all
            p_hat = min(max(p_hat * min(max(factor, 0.8), 1.25), 0.0), 1.0)

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

    # Most likely day of the low: median timing in past windows that actually dropped
    # (same-time-of-year ones when there are enough of them).
    season_events = event & near_season
    pick = season_events if season_events.sum() >= 5 else event
    likely_low_day = None
    if pick.sum() >= 3:
        offset = int(round(float(np.median(low_offset[pick]))))
        likely_low_day = (today + pd.Timedelta(days=offset)).date().isoformat()

    return {
        "p_drop": round(p_hat, 3),
        "expected_drop_pct": round(expected_drop * 100, 1),
        "expected_drop_usd": round(price * expected_drop, 2),
        "interval_low_usd": round(low, 2),
        "interval_high_usd": round(high, 2),
        "predicted_low_usd": round(mid, 2),
        "confidence": _confidence(len(s), int(event.sum())),
        "today": today.date().isoformat(),
        "likely_low_day": likely_low_day,
        "history_days": int(len(s)),
        "n_events": int(event.sum()),
        "enough_data": True,
    }
