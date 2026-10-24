
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

INPUT_FILE = ROOT / "data" / "raw" / "apify_output.json"
OUTPUT_FILE = ROOT / "data" / "processed" / "price_history.json"


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

    currency_symbol = offers.get("priceCurrency")
    marketplace = product.get("marketplace", "")

    if currency_symbol == "$" and "amazon.com" in marketplace:
        currency = "USD"
    else:
        currency = currency_symbol

    return {
        "product_id": details.get("asin"),
        "title": product.get("name"),
        "url": product.get("url") or product.get("inputUrl"),
        "timestamp": timestamp,
        "price": float(price),
        "currency": currency,
        "in_stock": details.get("inStock"),
        "source": "apify",
        "data_type": "observed",
    }


def main():
    with INPUT_FILE.open(encoding="utf-8") as file:
        products = json.load(file)

    normalized = []

    for product in products:
        record = normalize_product(product)

        if record is not None:
            normalized.append(record)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    with OUTPUT_FILE.open("w", encoding="utf-8") as file:
        json.dump(normalized, file, indent=2, ensure_ascii=False)

    print(f"Input records: {len(products)}")
    print(f"Normalized records: {len(normalized)}")
    print(f"Saved to: {OUTPUT_FILE}")

    for record in normalized:
        print(
            f'{record["title"]}: '
            f'{record["currency"]} {record["price"]:.2f}'
        )


if __name__ == "__main__":
    main()
