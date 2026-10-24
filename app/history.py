"""Simulated price history. Every row it produces is labeled source='simulated'."""
import hashlib

import numpy as np
import pandas as pd

# (month, first_day, last_day, typical_discount): rough US shopping-event windows
SALES_WINDOWS = [
    (7, 10, 16, 0.12),   # Prime Day-style summer sale
    (8, 1, 20, 0.05),    # back to school
    (11, 20, 30, 0.15),  # Black Friday week
    (12, 1, 2, 0.12),    # Cyber Monday tail
    (12, 15, 24, 0.06),  # holiday sales
]


def _seed(product_id: str) -> int:
    return int(hashlib.sha256(product_id.encode()).hexdigest()[:8], 16)


def simulate_history(product_id, anchor_price, end_date, days=365, seed=None):
    """Daily prices ending on end_date; the last price equals anchor_price."""
    rng = np.random.default_rng(_seed(product_id) if seed is None else seed)
    dates = pd.date_range(end=pd.Timestamp(end_date).normalize(), periods=days, freq="D")

    level, x = np.ones(days), 0.0                       # slow mean-reverting wobble
    for i in range(days):
        x = 0.97 * x + rng.normal(0, 0.004)
        level[i] = 1 + x

    weekday_effect = 1 + rng.normal(0, 0.006, 7)[dates.dayofweek]

    discount = np.zeros(days)
    depth_cache = {}
    for i, d in enumerate(dates):
        for w, (month, lo, hi, mean) in enumerate(SALES_WINDOWS):
            if d.month == month and lo <= d.day <= hi:
                depth = depth_cache.setdefault((d.year, w), mean * rng.uniform(0.6, 1.3))
                discount[i] = max(discount[i], depth)

    i = 0
    while i < days:                                     # random short promos
        if rng.random() < 0.02:
            dur = int(rng.integers(1, 6))
            discount[i:i + dur] = np.maximum(discount[i:i + dur], rng.uniform(0.05, 0.20))
            i += dur
        else:
            i += 1

    price = level * weekday_effect * (1 - discount)
    price = price * (anchor_price / price[-1])
    return pd.DataFrame({
        "timestamp": dates.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "price": price.round(2),
    }).assign(product_id=product_id, source="simulated")
