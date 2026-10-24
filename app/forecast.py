"""Baseline drop forecast from a product's price history.

For every past day, look at the next `horizon_days` and ask: did the price fall
at least `drop_threshold` below that day's price? The share of days where it did
is the base drop probability, nudged toward same-time-of-year and same-weekday
windows (shrunk toward the overall rate so small samples don't dominate).
Output keys match the extension's prediction contract (percent + USD fields).
`interval_low_usd`/`interval_high_usd` = likely range of the lowest price within the window.
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
                "confidence": "low", "best_day": None,
                "history_days": int(len(s)), "n_events": 0, "enough_data": False}

    p = s.to_numpy()
    n = len(p) - horizon_days
    future_min = np.array([p[i + 1:i + 1 + horizon_days].min() for i in range(n)])
    drop = future_min / p[:n] - 1                      # e.g. -0.08 = fell 8%
    event = drop <= -drop_threshold
    starts = s.index[:n]

    p_all = float(event.mean())

    gap = np.abs(starts.dayofyear.to_numpy() - today.dayofyear)
    near_season = np.minimum(gap, 365 - gap) <= 21     # same time of year, +/- 3 weeks
    p_season = float(event[near_season].mean()) if near_season.any() else p_all
    p_hat = _shrink(p_season, int(near_season.sum()), p_all)

    same_dow = starts.dayofweek.to_numpy() == today.dayofweek
    p_dow = float(event[same_dow].mean()) if same_dow.any() else p_hat
    p_hat = _shrink(p_dow, int(same_dow.sum()), p_hat)

    sizes = -drop[event]                               # drop sizes when a drop happened
    expected_drop = float(sizes.mean()) if len(sizes) else 0.0

    # Interval = 10th-90th percentile of the LOWEST price you could pay within
    # the deadline window, using same-time-of-year windows when there are enough.
    # It includes windows where nothing dropped, and is capped at today's price
    # because buying now is always an option.
    pool = drop[near_season] if near_season.sum() >= 30 else drop
    low = max(price * (1 + float(np.quantile(pool, 0.1))), 0.0)
    high = min(price * (1 + float(np.quantile(pool, 0.9))), price)
    low = min(low, high)

    # first-pass best day: cheapest weekday relative to its trailing 28-day average
    rel = s / s.rolling(28, min_periods=14).mean()
    by_dow = rel.groupby(rel.index.dayofweek).mean()
    best = min(range(horizon_days + 1),
               key=lambda o: by_dow.get((today + pd.Timedelta(days=o)).dayofweek, 1.0))

    return {
        "p_drop": round(p_hat, 3),
        "expected_drop_pct": round(expected_drop * 100, 1),
        "expected_drop_usd": round(price * expected_drop, 2),
        "interval_low_usd": round(low, 2),
        "interval_high_usd": round(high, 2),
        "confidence": _confidence(len(s), int(event.sum())),
        "best_day": (today + pd.Timedelta(days=best)).date().isoformat(),
        "history_days": int(len(s)),
        "n_events": int(event.sum()),
        "enough_data": True,
    }
