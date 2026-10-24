"""Copy the existing JSON price history into Tiger Data (safe to run repeatedly).

Run from backend/:  python -m app.migrate_to_tiger
Needs TIGER_DATABASE_URL in .env (the connection string from your Tiger Data service).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def main():
    if not os.getenv("TIGER_DATABASE_URL"):
        raise SystemExit("TIGER_DATABASE_URL is missing. Add it to backend/.env first.")

    from app import history_store as hs

    rows = hs.load_rows()
    if not rows:
        raise SystemExit(f"No rows found in {hs.HISTORY_PATH}. Nothing to migrate.")

    # Call the database directly (not save_observations) so a failure is loud
    # instead of silently falling back to the JSON file we are copying from.
    added, total = hs._db_save(rows)
    print(f"Read {len(rows)} rows from {hs.HISTORY_PATH.name}.")
    print(f"Added {added} new rows to Tiger Data (table now has {total}).")


if __name__ == "__main__":
    main()
