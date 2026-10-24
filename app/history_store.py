"""Append-only price history. Never overwrites old rows.

Rows look like: {product_id, timestamp (ISO UTC), price, currency, source, ...}
source is 'scraped' (live Apify run) or 'simulated' (generated backfill).
"""
import json
import os
from pathlib import Path

import pandas as pd

from app.history import simulate_history

ROOT = Path(__file__).resolve().parent.parent
HISTORY_PATH = ROOT / "data" / "processed" / "price_history.json"
MIN_DAYS = 365


def _key(row):
    return (row["product_id"], row["timestamp"], row["source"])


def load_rows(path=None):
    path = Path(path or HISTORY_PATH)
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_observations(new_rows, path=None):
    """Append rows we haven't seen before. Returns (added, total)."""
    path = Path(path or HISTORY_PATH)
    old = load_rows(path)
    seen = {_key(r) for r in old}
    added = []
    for r in new_rows:
        if r.get("product_id") and r.get("price") is not None and _key(r) not in seen:
            seen.add(_key(r))
            added.append(r)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(old + added, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)                  # a crash can't leave a half-written file
    return len(added), len(old) + len(added)


def ensure_history(product_id, current_price, path=None, min_days=MIN_DAYS):
    """Make sure this product has ~min_days of history, adding LABELED simulated
    rows before the earliest real row if it doesn't. Safe to call repeatedly."""
    rows = [r for r in load_rows(path) if r.get("product_id") == product_id]
    real = [r for r in rows if r["source"] != "simulated"]
    sim = [r for r in rows if r["source"] == "simulated"]
    if sim:
        return
    if real:
        first = min(real, key=lambda r: r["timestamp"])
        anchor, start = first["price"], pd.Timestamp(first["timestamp"]).tz_localize(None) if pd.Timestamp(first["timestamp"]).tzinfo else pd.Timestamp(first["timestamp"])
        span = (pd.Timestamp(max(r["timestamp"] for r in real)).tz_localize(None) - start).days + 1
    else:
        anchor, start, span = current_price, pd.Timestamp.today().normalize(), 0
    if span >= min_days:
        return
    end = start.normalize() - pd.Timedelta(days=1)
    df = simulate_history(product_id, anchor, end, days=min_days - span)
    df["currency"] = (real[0].get("currency") if real else None) or "USD"
    save_observations(df.to_dict("records"), path)


def get_history(product_id, path=None) -> pd.DataFrame:
    """All rows for one product. If real 'historical' (Keepa) rows exist, any
    simulated rows from the same period are dropped so they can't mix in."""
    rows = [r for r in load_rows(path) if r.get("product_id") == product_id]
    cols = ["timestamp", "price", "source"]
    if not rows:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(rows)[cols]
    ts = pd.to_datetime(df["timestamp"], utc=True, format="ISO8601")
    hist = ts[df["source"] == "historical"]
    if not hist.empty:
        stale = (df["source"] == "simulated") & (ts >= hist.min())
        df = df[~stale]
    return df.reset_index(drop=True)
