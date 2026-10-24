
import json
import os
from pathlib import Path

from apify_client import ApifyClient
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

TOKEN = os.getenv("APIFY_API_TOKEN")

# Official E-commerce Scraping Tool Actor ID.
ACTOR_ID = "2APbAvDfNDOWXbkWf"

PRODUCTS_FILE = ROOT / "products.json"
OUTPUT_FILE = ROOT / "data" / "raw" / "apify_output.json"


def main():
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

    # Keep the first test small to control cost.
    run_input = {
        "detailsUrls": urls[:1]
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

    OUTPUT_FILE.parent.mkdir(
        parents=True, exist_ok=True
    )

    with OUTPUT_FILE.open("w", encoding="utf-8") as file:
        json.dump(dataset_items, file, indent=2, ensure_ascii=False)

    print(f"Records downloaded: {len(dataset_items)}")
    print(f"Saved raw output to: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
