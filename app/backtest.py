"""Backtest: how good are our predictions, judged on the past?

Walk through history one day at a time. On each test day, pretend it is "today":
give the forecast ONLY the prices up to that day (no peeking), record the drop
probability it produced, then look at what really happened over the next
`deadline` days. Comparing the two answers "when we say 70%, does it happen
about 70% of the time?" (calibration).

Run from backend/:
    python -m app.backtest B0FMYVYCY7 --deadline 14 --savings 5
Writes data/backtest/<product>_<deadline>d_<savings>pct.png (+ .json).
Note: on simulated history this only checks that we recover the pattern the
simulator planted. Use products with real history for real evidence.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from app.forecast import daily_series, forecast, history_source

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "backtest"
BIN_EDGES = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0001]
CONFIDENCE_LEVELS = (50, 65, 80)


def backtest(history, deadline_days=14, savings_pct=5.0, step=3, min_train_days=180):
    """Returns {rows, summary, bins, wait_check}. `history` has timestamp/price/source."""
    threshold = savings_pct / 100
    s = daily_series(history)
    ts = pd.to_datetime(history["timestamp"], utc=True, format="ISO8601").dt.tz_localize(None).dt.normalize()
    prices = s.to_numpy()

    first_test = s.index[0] + pd.Timedelta(days=min_train_days)
    last_test = s.index[-1] - pd.Timedelta(days=deadline_days)
    # outcome of every possible start day, so we can say what the plain drop rate
    # "so far" was on each test day (only outcomes already known by then)
    n_all = len(prices) - deadline_days
    ev_all = np.array([prices[i + 1:i + 1 + deadline_days].min() / prices[i] - 1 <= -threshold
                       for i in range(max(n_all, 0))], dtype=float)
    rows = []
    for t in pd.date_range(first_test, last_test, freq=f"{step}D"):
        past = history[(ts <= t).to_numpy()]               # only what was known on day t
        price = float(s.loc[t])
        fc = forecast(past, price, deadline_days, threshold, today=t)
        if not fc["enough_data"]:
            continue
        i = s.index.get_loc(t)
        future_min = prices[i + 1:i + 1 + deadline_days].min()
        known = ev_all[:max(i - deadline_days + 1, 0)]
        rows.append({"date": t.date().isoformat(), "p_drop": fc["p_drop"],
                     "base": float(known.mean()) if len(known) else float(ev_all.mean()),
                     "dropped": bool(future_min / price - 1 <= -threshold),
                     "price": round(price, 2), "future_min": round(float(future_min), 2)})

    if not rows:
        return {"rows": [], "summary": {"n": 0}, "bins": [], "wait_check": []}

    p = np.array([r["p_drop"] for r in rows])
    y = np.array([r["dropped"] for r in rows], dtype=float)
    base = float(y.mean())
    summary = {
        "n": len(rows),
        "deadline_days": deadline_days,
        "savings_pct": savings_pct,
        "actual_drop_rate": round(base, 3),
        "mean_predicted": round(float(p.mean()), 3),
        "brier": round(float(((p - y) ** 2).mean()), 4),
        # the bar to beat: always guess the plain drop rate seen so far (no hindsight)
        "brier_constant_guess": round(float(((np.array([r["base"] for r in rows]) - y) ** 2).mean()), 4),
        # same, but using the whole test period's rate (needs hindsight; shown for reference)
        "brier_hindsight_constant": round(float(((base - y) ** 2).mean()), 4),
        "first_test_day": rows[0]["date"], "last_test_day": rows[-1]["date"],
        "data_source": history_source(history),
    }

    bins = []
    for lo, hi in zip(BIN_EDGES[:-1], BIN_EDGES[1:]):
        m = (p >= lo) & (p < hi)
        if m.any():
            bins.append({"range": f"{round(lo * 100)}-{min(round(hi * 100), 100)}%", "n": int(m.sum()),
                         "mean_predicted": round(float(p[m].mean()), 3),
                         "actual_rate": round(float(y[m].mean()), 3)})

    wait_check = []
    for c in CONFIDENCE_LEVELS:
        m = p * 100 >= c
        wait_check.append({"confidence_pct": c, "n_wait": int(m.sum()),
                           "hit_rate": round(float(y[m].mean()), 3) if m.any() else None})
    return {"rows": rows, "summary": summary, "bins": bins, "wait_check": wait_check}


def report(result):
    s = result["summary"]
    if not s["n"]:
        return "Not enough history to backtest (need about 6 months before the test period)."
    skill = 1 - s["brier"] / s["brier_constant_guess"] if s["brier_constant_guess"] else 0.0
    lines = [
        f"Backtest: {s['n']} test days ({s['first_test_day']} to {s['last_test_day']}), "
        f"{s['savings_pct']:g}% drop within {s['deadline_days']} days, data: {s['data_source']}",
        f"A drop really happened {s['actual_drop_rate']:.0%} of the time; we predicted {s['mean_predicted']:.0%} on average.",
        f"Brier score {s['brier']} vs {s['brier_constant_guess']} for always guessing the drop rate seen so far "
        f"({skill:+.0%} {'better' if skill >= 0 else 'worse'}).",
        "", "When we predicted...   days   a drop actually happened",
    ]
    for b in result["bins"]:
        lines.append(f"  {b['range']:<10} (avg {b['mean_predicted']:.0%})  {b['n']:>4}   {b['actual_rate']:.0%}")
    lines.append("")
    for w in result["wait_check"]:
        hit = "n/a" if w["hit_rate"] is None else f"{w['hit_rate']:.0%}"
        lines.append(f"With a {w['confidence_pct']}% confidence setting we said Wait on {w['n_wait']} days; the drop happened {hit} of those times.")
    lines.append("(Test days overlap, so treat small differences as noise.)")
    return "\n".join(lines)


def chart(result, path, title=""):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    s, bins = result["summary"], result["bins"]
    fig, ax = plt.subplots(figsize=(6, 5.2), dpi=150)
    ax.plot([0, 1], [0, 1], "--", color="#9a9a9a", lw=1, label="perfect calibration")
    if bins:
        x = [b["mean_predicted"] for b in bins]
        yv = [b["actual_rate"] for b in bins]
        ax.plot(x, yv, "-", color="#2b6cb0", lw=1.5)
        ax.scatter(x, yv, s=[30 + 6 * b["n"] ** 0.5 * 4 for b in bins], color="#2b6cb0", zorder=3, label="our predictions")
        for b, xi, yi in zip(bins, x, yv):
            ax.annotate(f"n={b['n']}", (xi, yi), textcoords="offset points", xytext=(6, -12), fontsize=7, color="#555")
    ax.set_xlim(0, 1); ax.set_ylim(0, 1)
    ax.set_xlabel("Chance of a drop we predicted"); ax.set_ylabel("How often a drop really happened")
    ax.xaxis.set_major_formatter(lambda v, _: f"{v:.0%}"); ax.yaxis.set_major_formatter(lambda v, _: f"{v:.0%}")
    ax.set_title(title or "Do our probabilities match reality?", fontsize=11, loc="left")
    ax.text(0.02, 0.97, f"{s['n']} test days, {s['savings_pct']:g}% drop within {s['deadline_days']} days\n"
            f"data: {s['data_source']}   Brier {s['brier']} (constant guess {s['brier_constant_guess']})",
            transform=ax.transAxes, va="top", fontsize=7.5, color="#444")
    ax.spines[["top", "right"]].set_visible(False); ax.legend(loc="lower right", frameon=False, fontsize=8)
    fig.tight_layout(); fig.savefig(path); plt.close(fig)


def main():
    from app.history_store import get_history

    ap = argparse.ArgumentParser()
    ap.add_argument("product_id")
    ap.add_argument("--deadline", type=int, default=14)
    ap.add_argument("--savings", type=float, default=5.0)
    ap.add_argument("--min-train", type=int, default=180, help="days of history before the first test day")
    a = ap.parse_args()

    history = get_history(a.product_id)
    if history.empty:
        raise SystemExit(f"No history for {a.product_id}. Run python -m app.fetch_history {a.product_id} first.")
    result = backtest(history, a.deadline, a.savings, min_train_days=a.min_train)
    print(report(result))
    if result["summary"]["n"]:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        stem = OUT_DIR / f"{a.product_id}_{a.deadline}d_{a.savings:g}pct"
        stem.with_suffix(".json").write_text(json.dumps({k: v for k, v in result.items() if k != "rows"}, indent=2))
        try:
            chart(result, stem.with_suffix(".png"), f"{a.product_id}: do our probabilities match reality?")
            print(f"\nChart saved to {stem.with_suffix('.png')}")
        except ImportError:
            print("\n(Install matplotlib to also get the chart: python -m pip install matplotlib)")


if __name__ == "__main__":
    main()
