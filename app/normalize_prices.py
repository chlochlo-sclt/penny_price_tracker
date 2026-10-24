import json
import re
import sys
from pathlib import Path

from app.history_store import save_observations

ROOT = Path(__file__).resolve().parent.parent

INPUT_FILE = ROOT / "data" / "raw" / "apify_output.json"

ASIN_IN_URL = re.compile(r"/(?:dp|gp/product)/([A-Z0-9]{10})")


def asin_from_url(*urls):
    for url in urls:
        match = ASIN_IN_URL.search(url or "")
        if match:
            return match.group(1)
    return None


def normalize_product(product):
    details = product.get("additionalProperties") or {}
    offers = product.get("offers") or {}

    price = offers.get("price")
    timestamp = (
        product.get("scrapedAt")
        or product.get("date")
        or product.get("scrapDate")
    )

    # Skip records that cannot provide a usable price.
    if price is None or not timestamp:
        return None

    # The Apify output has no ASIN field, so read it from the URL. This is the
    # same ID the extension sends, so scraped history and /predict line up.
    product_id = details.get("asin") or asin_from_url(
        product.get("url"), product.get("inputUrl")
    )
    if not product_id:
        return None

    currency_symbol = offers.get("priceCurrency")
    marketplace = product.get("marketplace", "")

    if currency_symbol == "$" and "amazon.com" in marketplace:
        currency = "USD"
    else:
        currency = currency_symbol

    return {
        "product_id": product_id,
        "title": product.get("name"),
        "url": product.get("url") or product.get("inputUrl"),
        "timestamp": timestamp,
        "price": float(price),
        "currency": currency,
        "in_stock": details.get("inStock"),
        "source": "scraped",
        "data_type": "observed",
    }


def main(input_file=None):
    input_file = Path(input_file) if input_file else INPUT_FILE

    with input_file.open(encoding="utf-8") as file:
        products = json.load(file)

    normalized = []

    for product in products:
        record = normalize_product(product)

        if record is not None:
            normalized.append(record)

    # APPEND to the history file instead of overwriting it, so every scrape
    # adds a data point and old ones are never lost.
    added, total = save_observations(normalized)

    print(f"Input records: {len(products)}")
    print(f"Normalized records: {len(normalized)}")
    print(f"New rows added to history: {added} (history now has {total})")

    for record in normalized:
        print(
            f'{record["title"]}: '
            f'{record["currency"]} {record["price"]:.2f}'
        )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
