import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from apify_client import ApifyClient
from dotenv import load_dotenv

from app.normalize_prices import main as normalize_main

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

TOKEN = os.getenv("APIFY_API_TOKEN")

# Official E-commerce Scraping Tool Actor ID.
ACTOR_ID = "2APbAvDfNDOWXbkWf"

PRODUCTS_FILE = ROOT / "products.json"
RAW_DIR = ROOT / "data" / "raw"
LATEST_FILE = RAW_DIR / "apify_output.json"


def main(limit=1):
    if not TOKEN:
        raise RuntimeError(
            "APIFY_API_TOKEN is missing. Check backend/.env"
        )

    with PRODUCTS_FILE.open(encoding="utf-8") as file:
        products = json.load(file)

    urls = [
        {"url": product["product_url"]}
        for product in products
    ]

    if not urls:
        raise RuntimeError("No product URLs found.")

    # Keep test runs small to control cost; pass --all for every product.
    run_input = {
        "detailsUrls": urls[:limit] if limit else urls
    }

    client = ApifyClient(TOKEN)

    print("Starting Apify Actor...")
    run = client.actor(ACTOR_ID).call(
        run_input=run_input
    )

    if not run:
        raise RuntimeError("Apify did not return a run.")

    run_data = run.model_dump(by_alias=True)

    if run_data.get("status") != "SUCCEEDED":
        raise RuntimeError(
            f"Apify run status: {run_data.get('status')}"
        )

    dataset_id = run_data.get("defaultDatasetId")

    if not dataset_id:
        raise RuntimeError("No output dataset was returned.")

    print(f"Run succeeded. Dataset: {dataset_id}")

    dataset_items = list(
        client.dataset(dataset_id).iterate_items()
    )

    RAW_DIR.mkdir(parents=True, exist_ok=True)

    # Keep every raw run (timestamped) so history can be rebuilt if
    # normalization ever has a bug, plus a "latest" copy.
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    run_file = RAW_DIR / f"apify_{stamp}.json"

    for target in (run_file, LATEST_FILE):
        with target.open("w", encoding="utf-8") as file:
            json.dump(dataset_items, file, indent=2, ensure_ascii=False)

    print(f"Records downloaded: {len(dataset_items)}")
    print(f"Saved raw output to: {run_file}")

    # Save the new prices into the history right away.
    normalize_main(run_file)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="scrape every product in products.json")
    args = parser.parse_args()
    main(limit=None if args.all else 1)
