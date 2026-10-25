"""Append-only price history. Never overwrites old rows.

Rows look like: {product_id, timestamp (ISO UTC), price, currency, source, ...}
source is 'scraped' (live scrape), 'historical' (real Keepa history) or
'simulated' (generated backfill).

Storage: if TIGER_DATABASE_URL is set, rows live in a Tiger Data (TimescaleDB)
hypertable called `prices`. If it is not set, or Tiger Data can't be reached,
they live in data/processed/price_history.json, so the demo never breaks.
Every function takes an optional `path`; passing one forces the JSON file
(that is how the tests run without a database).
"""
import json
import os
import sys
import threading
import time
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

from app.history import simulate_history

ROOT = Path(__file__).resolve().parent.parent

# Every entry point (API, CLI tools, a bare python -c) must see TIGER_DATABASE_URL,
# not just the scripts that happen to call load_dotenv themselves.
load_dotenv(ROOT / ".env")
HISTORY_PATH = ROOT / "data" / "processed" / "price_history.json"
MIN_DAYS = 365
MIN_REAL_DAYS = 60   # with this much real history we use it as is, no simulated filler


def _key(row):
    return (row["product_id"], row["timestamp"], row["source"])


# ---------------------------------------------------------------- Tiger Data

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS prices (
    product_id TEXT        NOT NULL,
    ts         TIMESTAMPTZ NOT NULL,
    price      NUMERIC(12,2) NOT NULL,
    currency   TEXT,
    source     TEXT        NOT NULL,
    title      TEXT,
    data_type  TEXT,
    PRIMARY KEY (product_id, ts, source)
)
"""
HYPERTABLE_SQL = "SELECT create_hypertable('prices', 'ts', if_not_exists => TRUE)"
# every read is "one product's whole history", so index that way
INDEX_SQL = "CREATE INDEX IF NOT EXISTS prices_product_ts ON prices (product_id, ts)"
INSERT_SQL = (
    "INSERT INTO prices (product_id, ts, price, currency, source, title, data_type) "
    "VALUES %s ON CONFLICT DO NOTHING"
)
SELECT_SQL = (
    "SELECT product_id, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS timestamp, "
    "price::float8 AS price, currency, source, title, data_type "
    "FROM prices WHERE product_id = %s ORDER BY ts"
)
SELECT_ALL_SQL = (
    "SELECT product_id, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS timestamp, "
    "price::float8 AS price, currency, source, title, data_type "
    "FROM prices ORDER BY product_id, ts"
)
COUNT_SQL = "SELECT count(*) FROM prices"

_db_ready = False


def _db_url():
    return os.environ.get("TIGER_DATABASE_URL") or None


_conn = None
_conn_lock = threading.Lock()
CONNECT_TIMEOUT = 3          # per address psycopg2 tries
DB_COOLDOWN_SECONDS = 60     # after a failure, use the JSON file without retrying
_db_down_until = 0.0
_query_lock = threading.RLock()


def _connect():
    """One reusable connection per process.

    A fresh SSL connection to a cloud Postgres costs a few hundred ms, and one
    /predict needs several queries, so reconnecting each time made the API slow
    enough for the extension to time out. Reconnects automatically if the link
    has dropped.
    """
    global _conn
    import psycopg2
    with _conn_lock:
        if _conn is not None:
            try:
                if _conn.closed:
                    _conn = None
                else:
                    with _conn.cursor() as cur:
                        cur.execute("SELECT 1")
                    return _conn
            except Exception:
                try:
                    _conn.close()
                except Exception:
                    pass
                _conn = None
        _conn = psycopg2.connect(_db_url(), connect_timeout=CONNECT_TIMEOUT)
        return _conn


def _ensure_schema(conn):
    """Create the table (and make it a hypertable when TimescaleDB is there)."""
    global _db_ready
    if _db_ready:
        return
    with conn.cursor() as cur:
        cur.execute(SCHEMA_SQL)
        try:
            cur.execute("SAVEPOINT hyper")
            cur.execute(HYPERTABLE_SQL)
        except Exception:                   # plain Postgres: a normal table is fine
            cur.execute("ROLLBACK TO SAVEPOINT hyper")
        cur.execute(INDEX_SQL)
    conn.commit()
    _db_ready = True


def _db_is_down():
    """True while we're in the cooldown after a failed connection.

    A hostname can resolve to many addresses and psycopg2 waits CONNECT_TIMEOUT
    on each, so a down database made every request take half a minute before
    falling back. After one failure we skip the database entirely for
    DB_COOLDOWN_SECONDS and serve from the JSON file at once."""
    return time.monotonic() < _db_down_until


def _mark_db_down():
    global _db_down_until
    _db_down_until = time.monotonic() + DB_COOLDOWN_SECONDS


def _query(fn):
    """Run fn(conn) with the shared connection, holding the lock for the whole
    query. FastAPI serves sync endpoints on a thread pool, and one psycopg2
    connection must not be used by two threads at once. Serializing is fine at
    our request rate and avoids a pool. On any error the connection is dropped
    so the next call reconnects."""
    with _query_lock:
        conn = _connect()
        try:
            _ensure_schema(conn)
            return fn(conn)
        except Exception:
            _drop_conn()
            _mark_db_down()
            raise


def _drop_conn():
    """Forget the shared connection so the next call makes a fresh one."""
    global _conn
    with _conn_lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None


def _db_rows(rows):
    return [(r["product_id"], r["timestamp"], r["price"], r.get("currency"), r["source"],
             r.get("title"), r.get("data_type")) for r in rows]


def _db_save(new_rows):
    from psycopg2.extras import execute_values
    good = [r for r in new_rows if r.get("product_id") and r.get("price") is not None]

    def run(conn):
        with conn.cursor() as cur:
            cur.execute(COUNT_SQL)
            before = cur.fetchone()[0]
            if good:
                execute_values(cur, INSERT_SQL, _db_rows(good))
            cur.execute(COUNT_SQL)
            after = cur.fetchone()[0]
        conn.commit()
        return after - before, after

    return _query(run)


def _fetch(sql, args=None):
    def run(conn):
        with conn.cursor() as cur:
            cur.execute(sql, args)
            names = [d[0] for d in cur.description]
            return [dict(zip(names, row)) for row in cur.fetchall()]
    return _query(run)


def _db_load(product_id):
    return _fetch(SELECT_SQL, (product_id,))


def _db_load_all():
    return _fetch(SELECT_ALL_SQL)


def _use_db(path):
    """Tiger Data is used only when configured, no explicit file path is given,
    and we are not in the cooldown after a failed connection."""
    return path is None and _db_url() is not None and not _db_is_down()


def _warn_fallback(err):
    print(f"[history_store] Tiger Data unavailable ({type(err).__name__}: {err}); "
          f"using {HISTORY_PATH.name} instead.", file=sys.stderr)


# ------------------------------------------------------------- public API

def load_rows(path=None):
    """All rows for every product, from Tiger Data when configured, else the JSON file."""
    if _use_db(path):
        try:
            return _db_load_all()
        except Exception as err:
            _warn_fallback(err)
    return _json_load(path)


def save_observations(new_rows, path=None):
    """Append rows we haven't seen before. Returns (added, total)."""
    for pid in {r.get("product_id") for r in new_rows}:
        invalidate_cache(pid)
    if _use_db(path):
        try:
            return _db_save(new_rows)
        except Exception as err:             # unreachable DB must not lose scraped data
            _warn_fallback(err)
    return _json_save(new_rows, path)


CACHE_SECONDS = 30
_cache = {}                      # product_id -> (fetched_at, rows)
_cache_lock = threading.Lock()


def _cache_get(product_id):
    with _cache_lock:
        hit = _cache.get(product_id)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    return None


def _cache_put(product_id, rows):
    with _cache_lock:
        _cache[product_id] = (time.monotonic(), rows)


def invalidate_cache(product_id=None):
    """Drop cached rows after a write, so new history shows up immediately."""
    with _cache_lock:
        _cache.pop(product_id, None) if product_id else _cache.clear()


def _product_rows(product_id, path=None):
    """One product's rows. Cached briefly: a single /predict asks three times
    (history status, ensure, load) and each uncached read is a round trip to a
    remote database, which is most of the request's time."""
    if path is None:
        cached = _cache_get(product_id)
        if cached is not None:
            return cached
    if _use_db(path):
        try:
            rows = _db_load(product_id)
            _cache_put(product_id, rows)
            return rows
        except Exception as err:
            _warn_fallback(err)
    rows = [r for r in _json_load(path) if r.get("product_id") == product_id]
    if path is None:
        _cache_put(product_id, rows)
    return rows


def _json_load(path=None):
    path = Path(path or HISTORY_PATH)
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _json_save(new_rows, path=None):
    path = Path(path or HISTORY_PATH)
    old = _json_load(path)
    seen = {_key(r) for r in old}
    added = []
    for r in new_rows:
        if r.get("product_id") and r.get("price") is not None and _key(r) not in seen:
            seen.add(_key(r))
            added.append(r)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(old + added, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)                  # a crash can't leave a half-written file
    return len(added), len(old) + len(added)


def ensure_history(product_id, current_price, path=None, min_days=MIN_DAYS):
    """Make sure this product has ~min_days of history, adding LABELED simulated
    rows before the earliest real row if it doesn't. Safe to call repeatedly."""
    rows = _product_rows(product_id, path)
    real = [r for r in rows if r["source"] != "simulated"]
    sim = [r for r in rows if r["source"] == "simulated"]
    if sim:
        return
    if real:
        first = min(real, key=lambda r: r["timestamp"])
        anchor, start = first["price"], pd.Timestamp(first["timestamp"]).tz_localize(None) if pd.Timestamp(first["timestamp"]).tzinfo else pd.Timestamp(first["timestamp"])
        span = (pd.Timestamp(max(r["timestamp"] for r in real)).tz_localize(None) - start).days + 1
    else:
        anchor, start, span = current_price, pd.Timestamp.today().normalize(), 0
    if span >= min_days or (real and span >= MIN_REAL_DAYS):
        return
    end = start.normalize() - pd.Timedelta(days=1)
    df = simulate_history(product_id, anchor, end, days=min_days - span)
    df["currency"] = (real[0].get("currency") if real else None) or "USD"
    save_observations(df.to_dict("records"), path)


def has_real_history(product_id, path=None):
    """True if we hold ANY non-simulated row for this product.

    This is the "have we already fetched it?" test. Span is not usable for that:
    a product whose whole Keepa history is 40 days is fully fetched but would
    never reach MIN_REAL_DAYS, so a span-based check would re-fetch it forever.
    """
    return any(r["source"] != "simulated" for r in _product_rows(product_id, path))


def real_span_days(product_id, path=None):
    """Days covered by this product's non-simulated history (0 if none)."""
    real = [r["timestamp"] for r in _product_rows(product_id, path) if r["source"] != "simulated"]
    if not real:
        return 0
    ts = pd.to_datetime(pd.Series(real), utc=True, format="ISO8601")
    return int((ts.max() - ts.min()).days)


def get_history(product_id, path=None) -> pd.DataFrame:
    """All rows for one product. Simulated rows never override real ones: with
    enough real history they are all dropped, otherwise only the ones that
    overlap the real period are."""
    rows = _product_rows(product_id, path)
    cols = ["timestamp", "price", "source"]
    if not rows:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(rows)[cols]
    ts = pd.to_datetime(df["timestamp"], utc=True, format="ISO8601")
    real = ts[df["source"] != "simulated"]
    if not real.empty:
        enough = (real.max() - real.min()).days >= MIN_REAL_DAYS
        stale = (df["source"] == "simulated") & (True if enough else (ts >= real.min()))
        df = df[~stale]
    return df.reset_index(drop=True)
