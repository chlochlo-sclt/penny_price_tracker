"""Fetch real Amazon price history in the background when the extension asks about
a product we have no real history for yet.

Flow: POST /predict answers immediately (labeled simulated if needed) and starts one
background Keepa fetch for that ASIN. The response carries history_status:
  "ready"        real history is stored; the answer uses it
  "fetching"     a fetch is running; call /predict again in ~30-60 s for the real answer
  "failed"       the last fetch found nothing or errored (retried after a cooldown)
  "unavailable"  live fetching is off (no APIFY_API_TOKEN, or LIVE_FETCH=0)
"""
import os
import re
import threading
import time
from pathlib import Path

from dotenv import load_dotenv

from app.history_store import MIN_REAL_DAYS, real_span_days

# The server process needs APIFY_API_TOKEN too, not just the CLI scripts.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")
COOLDOWN_SECONDS = 600          # don't re-try a failed ASIN for 10 minutes
STALE_FETCH_SECONDS = 600       # treat a fetch stuck this long as dead

_lock = threading.Lock()
_state = {}                      # asin -> {"status": "fetching"|"failed", "at": epoch, "error": str}


def enabled():
    return os.getenv("LIVE_FETCH", "1") != "0" and bool(os.getenv("APIFY_API_TOKEN"))


def _default_worker(asin):
    """Run Keepa through Apify and store whatever history comes back."""
    from app.fetch_history import fetch, pick_series
    from app.history_store import save_observations

    items = [i for i in fetch([asin]) if i.get("asin") == asin]
    if not items:
        raise RuntimeError("Keepa returned no record for this ASIN")
    _, rows = pick_series(items[0])
    if not rows:
        raise RuntimeError("Keepa returned no price history for this ASIN")
    save_observations(rows)


worker = _default_worker         # tests swap this out


def _run(asin):
    try:
        worker(asin)
        with _lock:
            _state.pop(asin, None)
    except Exception as exc:     # network, quota, no data: record and move on
        with _lock:
            _state[asin] = {"status": "failed", "at": time.time(), "error": str(exc)[:200]}


def history_status(product_id):
    if real_span_days(product_id) >= MIN_REAL_DAYS:
        return "ready"
    with _lock:
        s = _state.get(product_id)
    now = time.time()
    if s and s["status"] == "fetching" and now - s["at"] < STALE_FETCH_SECONDS:
        return "fetching"
    if s and s["status"] == "failed" and now - s["at"] < COOLDOWN_SECONDS:
        return "failed"
    return "unavailable" if not enabled() else "idle"


def ensure_real_history(product_id, background=True):
    """Return the history status, starting a background fetch if one is needed."""
    status = history_status(product_id)
    if status != "idle":
        return status
    if not ASIN_RE.match(product_id or ""):
        return "unavailable"
    with _lock:
        _state[product_id] = {"status": "fetching", "at": time.time(), "error": ""}
    if background:
        threading.Thread(target=_run, args=(product_id,), daemon=True).start()
    else:
        _run(product_id)
    return history_status(product_id)
