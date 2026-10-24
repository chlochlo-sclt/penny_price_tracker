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

# Which series best matches the price shown on the product page. The first one
# the Actor returns for a product wins. Check the field names in your first
# output (the script prints every *_history field it sees) and reorder if needed.
SERIES_PREFERENCE = ["buybox_price_history", "amazon_price_history", "new_price_history"]


def history_rows(item):
    """Convert one Keepa product record into price-history rows."""
    asin = item.get("asin")
    currency = item.get("currency") or "USD"
    if not asin:
        return []
    for field in SERIES_PREFERENCE:
        rows = [
            {
                "product_id": asin,
                "title": item.get("title"),
                "timestamp": p["seen_at"],
                "price": float(p["price"]),
                "currency": currency,
                "source": "historical",
                "data_type": field.replace("_price_history", ""),
            }
            for p in (item.get(field) or [])
            if p.get("price") is not None and p.get("seen_at")
        ]
        if rows:
            return rows
    return []


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
        rows = history_rows(item)
        fields = sorted(k for k in item if k.endswith("_history"))
        if not rows:
            print(f"{item.get('asin')}: NO usable price history. Fields seen: {fields}")
            continue
        added, total = save_observations(rows)
        first, last = min(r["timestamp"] for r in rows), max(r["timestamp"] for r in rows)
        print(f"{item.get('asin')}: {len(rows)} points ({first[:10]} to {last[:10]}), "
              f"{added} new, using {rows[0]['data_type']} series")


def main(asins=None):
    if not asins:
        products = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
        asins = [a for a in (asin_from_url(p["product_url"]) for p in products) if a][:5]
    print(f"Fetching history for: {asins}")
    save_items(fetch(asins))


if __name__ == "__main__":
    main(sys.argv[1:] or None)
