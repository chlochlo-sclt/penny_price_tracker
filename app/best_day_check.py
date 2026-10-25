"""Does a product actually have a best day, or is the date meaningless?

Run from the project root:
    python -m app.best_day_check B00TTD9BRC
    python -m app.best_day_check B00TTD9BRC B00AHAWWO0 --deadline 35 --savings 10

For every past window that dropped, we record how many days in the lowest price
landed, then show how those offsets are spread. If they are spread evenly across
the window, the "best day" is just the middle of the deadline and means nothing.
If they cluster, the date is real.
"""
import argparse

import numpy as np
import pandas as pd

from app.forecast import daily_series
from app.history_store import load_rows


def offsets(history, deadline_days, savings_pct, today=None):
    s = daily_series(history)
    today = pd.Timestamp(today or pd.Timestamp.today()).normalize()
    p = s.to_numpy()
    n = len(p) - deadline_days
    if n < 30:
        return None, None
    w = np.array([p[i + 1:i + 1 + deadline_days] for i in range(n)])
    off = w.argmin(axis=1) + 1
    dropped = (w.min(axis=1) / p[:n] - 1) <= -(savings_pct / 100)
    starts = s.index[:n]
    gap = np.abs(starts.day_of_year.to_numpy() - today.day_of_year)
    near = np.minimum(gap, 365 - gap) <= 21
    pick = (dropped & near) if (dropped & near).sum() >= 5 else dropped
    return off[pick], deadline_days


def report(product_id, history, deadline_days, savings_pct):
    off, H = offsets(history, deadline_days, savings_pct)
    print(f"\n{product_id}  ({deadline_days}-day deadline, {savings_pct:g}% target)")
    if off is None or len(off) < 3:
        print("  not enough dropping windows to say anything")
        return
    q1, med, q3 = np.percentile(off, [25, 50, 75])
    iqr = q3 - q1
    # a uniform spread over 1..H has an IQR of about H/2
    uniform_iqr = H / 2
    tightness = 1 - iqr / uniform_iqr        # 0 = flat, 1 = all on one day
    bins = 7
    edges = np.linspace(1, H + 1, bins + 1)
    counts, _ = np.histogram(off, bins=edges)
    peak = max(counts.max(), 1)
    print(f"  {len(off)} dropping windows; low landed on day {q1:.0f}-{q3:.0f} "
          f"(median {med:.0f}) of {H}")
    for i in range(bins):
        lo, hi = int(edges[i]), int(edges[i + 1]) - 1
        bar = "#" * int(round(20 * counts[i] / peak))
        print(f"    days {lo:>2}-{hi:<2} {counts[i]:>4}  {bar}")
    if tightness < 0.15:
        verdict = "FLAT - the date is just the middle of the window, it means nothing"
    elif tightness < 0.4:
        verdict = "weak clustering - treat the date as rough"
    else:
        verdict = "CLUSTERED - the best day is real"
    print(f"  spread score {tightness:+.2f}  ->  {verdict}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("products", nargs="*", help="ASINs (default: all with real history)")
    ap.add_argument("--deadline", type=int, default=14)
    ap.add_argument("--savings", type=float, default=5.0)
    a = ap.parse_args()

    rows = [r for r in load_rows() if r["source"] != "simulated"]
    by_id = {}
    for r in rows:
        by_id.setdefault(r["product_id"], []).append(r)
    wanted = a.products or sorted(by_id)
    for pid in wanted:
        if pid not in by_id:
            print(f"\n{pid}: no real history stored")
            continue
        df = pd.DataFrame(by_id[pid])[["timestamp", "price", "source"]]
        report(pid, df, a.deadline, a.savings)


if __name__ == "__main__":
    main()
