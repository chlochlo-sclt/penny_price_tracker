"""Backtest every product with enough real history and print one summary table.

Run from backend/:  python -m app.backtest_all
                    python -m app.backtest_all --deadline 35 --savings 10
                    python -m app.backtest_all --min-days 300 --charts

This is the evidence table: one row per product, showing whether the forecast
beat the honest baseline (always guessing the drop rate seen so far).
"""
import argparse
import json

from app.backtest import OUT_DIR, backtest, chart
from app.forecast import clean_outliers
from app.history_store import load_rows

MIN_REAL_DAYS_FOR_TEST = 300      # need training history plus a test period


def _products(min_days):
    """Products with at least min_days of real (non-simulated) history."""
    import pandas as pd

    rows = [r for r in load_rows() if r["source"] != "simulated"]
    out = {}
    by_id = {}
    for r in rows:
        by_id.setdefault(r["product_id"], []).append(r)
    for pid, rs in by_id.items():
        df = pd.DataFrame(rs)[["timestamp", "price", "source"]]
        ts = pd.to_datetime(df["timestamp"], utc=True, format="ISO8601")
        span = (ts.max() - ts.min()).days
        if span >= min_days:
            out[pid] = (df, span, (rs[0].get("title") or "")[:40])
    return out


def run(deadline=14, savings=5.0, min_days=MIN_REAL_DAYS_FOR_TEST, charts=False):
    products = _products(min_days)
    if not products:
        print(f"No product has {min_days}+ days of real history yet.")
        print("Fetch more with: python -m app.fetch_history <ASINs>")
        return []

    results = []
    for pid, (df, span, title) in sorted(products.items()):
        r = backtest(df, deadline, savings)
        s = r["summary"]
        if not s.get("n"):
            continue
        skill = 1 - s["brier"] / s["brier_constant_guess"] if s["brier_constant_guess"] else 0.0
        spread = max((b["mean_predicted"] for b in r["bins"]), default=0) - \
                 min((b["mean_predicted"] for b in r["bins"]), default=0)
        best = max((w for w in r["wait_check"] if w["n_wait"]), key=lambda w: w["confidence_pct"], default=None)
        results.append({
            "product_id": pid, "title": title, "history_days": span, "n_test": s["n"],
            "actual_rate": s["actual_drop_rate"], "predicted": s["mean_predicted"],
            "skill_vs_baseline": round(skill, 3), "prediction_spread": round(spread, 3),
            "highest_confidence_wait": best["confidence_pct"] if best else None,
            "wait_hit_rate": best["hit_rate"] if best else None,
        })
        if charts:
            chart(r, OUT_DIR / f"{pid}_{deadline}d_{savings:g}pct.png", title or pid)

    head = (f"{'product':<12} {'days':>5} {'tested':>6} {'actual':>7} {'pred':>6} "
            f"{'vs base':>8} {'spread':>7}  waits")
    print(f"\n{deadline}-day deadline, {savings:g}% savings target\n")
    print(head)
    print("-" * len(head))
    for r in sorted(results, key=lambda x: -x["skill_vs_baseline"]):
        w = (f"{r['highest_confidence_wait']}%+ hit {r['wait_hit_rate']:.0%}"
             if r["highest_confidence_wait"] and r["wait_hit_rate"] is not None else "never says wait")
        print(f"{r['product_id']:<12} {r['history_days']:>5} {r['n_test']:>6} "
              f"{r['actual_rate']:>6.0%} {r['predicted']:>6.0%} "
              f"{r['skill_vs_baseline']:>+7.0%} {r['prediction_spread']:>7.2f}  {w}")
    print("\n'vs base' is better(+)/worse(-) than always guessing the rate seen so far.")
    print("'spread' is how much the predictions vary: 0.00 means one flat number for every day.")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"summary_{deadline}d_{savings:g}pct.json"
    path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Saved to {path}")
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deadline", type=int, default=14)
    ap.add_argument("--savings", type=float, default=5.0)
    ap.add_argument("--min-days", type=int, default=MIN_REAL_DAYS_FOR_TEST)
    ap.add_argument("--charts", action="store_true")
    a = ap.parse_args()
    run(a.deadline, a.savings, a.min_days, a.charts)


if __name__ == "__main__":
    main()
