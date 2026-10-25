"""Rebuild the Tiger Data hypertable with year-wide chunks.

Run from backend/:  python -m app.retune_tiger

Why: TimescaleDB splits a hypertable into chunks by time, 7 days by default.
Amazon price histories go back to 2011, so the table ended up with ~580 chunks,
and a query filtering on product_id with no time bound has to plan across all of
them. That planning cost made /predict take seconds. Year-wide chunks bring it
to ~16, which is the right size for this access pattern (one product's whole
history at once).

Safe by design: every row is written to a local JSON backup and read back before
the table is touched, and the rebuild runs in one transaction.
"""
import json
from pathlib import Path

from app import history_store as hs

ROOT = Path(__file__).resolve().parent.parent
BACKUP = ROOT / "data" / "processed" / "tiger_backup.json"
CHUNK_INTERVAL = "1 year"


def main():
    if not hs._db_url():
        raise SystemExit("TIGER_DATABASE_URL is missing. Add it to .env first.")

    rows = hs._db_load_all()
    if not rows:
        raise SystemExit("Tiger Data has no rows; nothing to retune.")

    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    BACKUP.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    verify = json.loads(BACKUP.read_text(encoding="utf-8"))
    if len(verify) != len(rows):
        raise SystemExit("Backup did not read back cleanly; stopping before any change.")
    print(f"Backed up {len(rows)} rows to {BACKUP}")

    def rebuild(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM timescaledb_information.chunks "
                        "WHERE hypertable_name = 'prices'")
            before = cur.fetchone()[0]
            cur.execute("DROP TABLE IF EXISTS prices")
            cur.execute(hs.SCHEMA_SQL)
            cur.execute("SELECT create_hypertable('prices', 'ts', if_not_exists => TRUE, "
                        "chunk_time_interval => INTERVAL %s)", (CHUNK_INTERVAL,))
            cur.execute(hs.INDEX_SQL)
        conn.commit()
        return before

    before = hs._query(rebuild)
    print(f"Rebuilt table (was {before} chunks, chunk interval now {CHUNK_INTERVAL})")

    added, total = hs._db_save(rows)
    print(f"Restored {added} rows (table now has {total})")
    if total != len(rows):
        print(f"WARNING: expected {len(rows)} rows. Backup is kept at {BACKUP}")
        return

    def count_chunks(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM timescaledb_information.chunks "
                        "WHERE hypertable_name = 'prices'")
            return cur.fetchone()[0]

    print(f"Chunks now: {hs._query(count_chunks)}")


if __name__ == "__main__":
    main()
