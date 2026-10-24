"""Pull real multi-year Amazon price history (Keepa data) through an Apify Actor.

Run from backend/:  python -m app.fetch_history            (first 5 products in products.json)
                    python -m app.fetch_history B0XXXXXXXX B0YYYYYYYY

Uses the community Actor radeance/keepa-scraper with include_price_history on.
Rows are saved with source="historical" and count as REAL data (not simulated).
Keepa only records a point when the price changes; forecast.py already turns that
into one price per day by carrying the last price forward.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.history_store import save_observations
from app.normalize_prices import asin_from_url

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
PRODUCTS_FILE = ROOT / "products.json"

ACTOR_ID = os.getenv("KEEPA_ACTOR_ID", "radeance/keepa-scraper")

# Series that match the price shown on the product page. "new" is the lowest
# price among ALL sellers, so it often sits below the page price: fallback only.
PRIMARY_SERIES = ["buybox_price_history", "amazon_price_history"]
FALLBACK_SERIES = ["new_price_history"]


def _series_rows(item, field):
    return [
        {
            "product_id": item.get("asin"),
            "title": item.get("title"),
            "timestamp": p["seen_at"],
            "price": float(p["price"]),
            "currency": item.get("currency") or "USD",
            "source": "historical",
            "data_type": field.replace("_price_history", ""),
        }
        for p in (item.get(field) or [])
        if p.get("price") is not None and p.get("seen_at")
    ]


def _span_days(rows):
    times = [datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")) for r in rows]
    return (max(times) - min(times)).days


def pick_series(item):
    """Choose the series that covers the most time; among those within 80% of the
    longest span, take the one with the most points (ties go to buy box)."""
    if not item.get("asin"):
        return None, []
    for group in (PRIMARY_SERIES, FALLBACK_SERIES):
        cands = [(f, _series_rows(item, f)) for f in group]
        cands = [(f, r) for f, r in cands if r]
        if cands:
            longest = max(_span_days(r) for _, r in cands)
            ok = [(f, r) for f, r in cands if _span_days(r) >= 0.8 * longest]
            return max(ok, key=lambda c: len(c[1]))
    return None, []


def history_rows(item):
    """Convert one Keepa product record into price-history rows."""
    return pick_series(item)[1]


def fetch(asins):
    from apify_client import ApifyClient
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    token = os.getenv("APIFY_API_TOKEN")
    if not token:
        raise RuntimeError("APIFY_API_TOKEN is missing. Check backend/.env")

    run = ApifyClient(token).actor(ACTOR_ID).call(run_input={
        "identifiers": asins,
        "marketplace": "us",
        "include_price_history": True,     # paid add-on: this is the history we want
        "include_offers_sellers": False,   # another paid add-on we don't need
    })
    items = list(ApifyClient(token).dataset(run.default_dataset_id).iterate_items())

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    raw_file = RAW_DIR / f"keepa_{stamp}.json"
    raw_file.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Saved raw Keepa output to {raw_file}")
    return items


def save_items(items):
    for item in items:
        asin = item.get("asin")
        print(f"\n{asin}: {(item.get('title') or '')[:60]}")
        for key, val in sorted(item.items()):
            if key.endswith("_history") and isinstance(val, list) and val \
                    and isinstance(val[0], dict) and "seen_at" in val[0] and "price" in val[0]:
                print(f"   {key}: {len(val)} points, {val[0]['seen_at'][:10]} to {val[-1]['seen_at'][:10]}")
        field, rows = pick_series(item)
        if not rows:
            print("   NO usable price history for this product.")
            continue
        added, _ = save_observations(rows)
        print(f"   -> saved {len(rows)} points from {field} ({added} new), "
              f"{_span_days(rows)} days of history")


def main(asins=None):
    if not asins:
        products = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
        asins = [a for a in (asin_from_url(p["product_url"]) for p in products) if a][:5]
    print(f"Fetching history for: {asins}")
    save_items(fetch(asins))


if __name__ == "__main__":
    main(sys.argv[1:] or None)
