"""Fetch one product's price right now, for the watchlist.

The watchlist needs today's price while the user is NOT on the product page,
so it cannot come from the extension. This scrapes a single product through the
official Apify e-commerce Actor (the same one scrape_apify.py uses, which draws
on the monthly platform allowance rather than the Keepa Actor's run trial) and
stores the result as ordinary scraped history.

Results are cached for CACHE_MINUTES so several watches on one product, or a
retry, cost nothing extra.
"""
import os
import time
from pathlib import Path

from dotenv import load_dotenv

from app.history_store import save_observations
from app.normalize_prices import normalize_product

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

ACTOR_ID = "2APbAvDfNDOWXbkWf"          # official E-commerce Scraping Tool
CACHE_MINUTES = 60
AMAZON_URL = "https://www.amazon.com/dp/{}"

_cache = {}                              # asin -> (fetched_at, record)


def enabled():
    return os.getenv("PRICE_CHECKS", "1") != "0" and bool(os.getenv("APIFY_API_TOKEN"))


def _scrape(asin):
    from apify_client import ApifyClient

    client = ApifyClient(os.getenv("APIFY_API_TOKEN"))
    run = client.actor(ACTOR_ID).call(
        run_input={"detailsUrls": [{"url": AMAZON_URL.format(asin)}]}
    )
    if not run:
        raise RuntimeError("Apify did not return a run")
    data = run.model_dump(by_alias=True)
    if data.get("status") != "SUCCEEDED":
        raise RuntimeError(f"Apify run status: {data.get('status')}")
    items = list(client.dataset(data["defaultDatasetId"]).iterate_items())
    for item in items:
        record = normalize_product(item)
        if record and record["product_id"] == asin:
            return record
    raise RuntimeError("no usable price in the Apify output")


def current_price(asin, force=False):
    """Returns {asin, price, currency, title, as_of, cached} or raises.

    The scraped price is appended to the product's history, so every watch check
    also makes the forecast a little better informed.
    """
    if not enabled():
        raise RuntimeError("price checks are off (PRICE_CHECKS=0 or no APIFY_API_TOKEN)")

    hit = _cache.get(asin)
    if hit and not force and time.time() - hit[0] < CACHE_MINUTES * 60:
        return {**hit[1], "cached": True}

    record = _scrape(asin)
    save_observations([record])
    out = {
        "asin": asin,
        "price": record["price"],
        "currency": record.get("currency") or "USD",
        "title": record.get("title"),
        "as_of": record["timestamp"],
    }
    _cache[asin] = (time.time(), out)
    return {**out, "cached": False}
