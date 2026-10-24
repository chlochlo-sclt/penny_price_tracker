"""Tests for history saving, forecasting, and the preference-aware decision.
Plain Python, no network. Run: pytest tests/test_logic.py"""
import pandas as pd

from app import history_store
from app.decision import decide
from app.forecast import forecast, history_source
from app.history_store import ensure_history, get_history, save_observations
from app.normalize_prices import asin_from_url, normalize_product


def _row(pid, ts, price, source="scraped"):
    return {"product_id": pid, "timestamp": ts, "price": price, "currency": "USD", "source": source}


def test_save_observations_appends_and_never_duplicates(tmp_path):
    path = tmp_path / "h.json"
    assert save_observations([_row("A", "2026-10-24T10:00:00Z", 10.0)], path) == (1, 1)
    assert save_observations([_row("A", "2026-10-24T10:00:00Z", 10.0)], path) == (0, 1)   # same row again
    assert save_observations([_row("A", "2026-10-25T10:00:00Z", 9.0)], path) == (1, 2)    # new scrape
    assert len(get_history("A", path)) == 2                                               # nothing overwritten


def test_rows_without_a_product_id_are_not_saved(tmp_path):
    path = tmp_path / "h.json"
    assert save_observations([_row(None, "2026-10-24T10:00:00Z", 10.0)], path) == (0, 0)


def test_ensure_history_adds_labeled_simulated_rows_once(tmp_path):
    path = tmp_path / "h.json"
    save_observations([_row("A", "2026-10-24T10:00:00Z", 100.0)], path)
    ensure_history("A", 100.0, path)
    ensure_history("A", 100.0, path)                       # second call adds nothing
    h = get_history("A", path)
    assert set(h["source"]) == {"scraped", "simulated"}
    assert (h["source"] == "simulated").sum() > 300
    assert history_source(h) == "mixed"


def test_forecast_returns_contract_fields_and_sane_values(tmp_path):
    path = tmp_path / "h.json"
    ensure_history("B", 80.0, path)
    h = get_history("B", path)
    fc = forecast(h, 80.0, 14, 0.05, today="2026-10-24")
    assert 0 <= fc["p_drop"] <= 1
    assert fc["interval_low_usd"] <= fc["interval_high_usd"] <= 80.0
    assert fc["confidence"] in {"low", "medium", "high"}
    assert history_source(h) == "simulated"


def test_forecast_with_thin_history_is_low_confidence(tmp_path):
    path = tmp_path / "h.json"
    save_observations([_row("C", "2026-10-24T10:00:00Z", 50.0)], path)
    fc = forecast(get_history("C", path), 50.0, 14, 0.05, today="2026-10-24")
    assert fc["confidence"] == "low" and not fc["enough_data"]
    assert decide(fc, 50.0)["recommendation"] == "buy_now"


def test_preferences_change_the_verdict():
    fc = {"p_drop": 0.70, "expected_drop_pct": 10.0, "expected_drop_usd": 10.0,
          "best_day": "2026-11-27", "history_days": 365, "enough_data": True}
    assert decide(fc, 100.0, {"risk_tolerance": "balanced"})["recommendation"] == "wait"
    assert decide(fc, 100.0, {"risk_tolerance": "cautious"})["recommendation"] == "buy_now"
    assert decide(fc, 100.0, {"min_savings_pct": 15})["recommendation"] == "buy_now"
    assert decide(fc, 100.0, {"budget_usd": 120})["recommendation"] == "buy_now"


def test_asin_is_read_from_the_url_and_marked_scraped():
    url = "https://www.amazon.com/Some-Name/dp/B0GR1JTFP8/ref=sr_1_4?crid=x"
    assert asin_from_url(None, url) == "B0GR1JTFP8"
    rec = normalize_product({"inputUrl": url, "name": "X", "offers": {"price": 5, "priceCurrency": "$"},
                             "marketplace": "www.amazon.com", "scrapedAt": "2026-10-24T19:02:20.575Z"})
    assert rec["product_id"] == "B0GR1JTFP8" and rec["source"] == "scraped" and rec["currency"] == "USD"


def _keepa_item(asin="B0KEEPATEST"):
    """Shaped like the Keepa Actor's output: a point only when the price changes."""
    import numpy as np
    rng = np.random.default_rng(1)
    days = pd.date_range("2023-10-01", "2026-10-20", freq="9D")
    price = 100.0
    pts = []
    for d in days:
        price = round(price * (1 + rng.normal(0, 0.03)), 2)
        pts.append({"seen_at": d.strftime("%Y-%m-%dT%H:%M:%SZ"), "price": price})
    pts.append({"seen_at": "2026-10-21T00:00:00Z", "price": None})   # "no offer" point is skipped
    return {"asin": asin, "title": "T", "currency": "USD", "new_price_history": pts}


def test_keepa_history_rows_are_saved_as_real_historical_data(tmp_path):
    from app.fetch_history import history_rows
    rows = history_rows(_keepa_item())
    assert rows and all(r["source"] == "historical" for r in rows)
    assert all(r["price"] > 0 for r in rows)                 # null points skipped
    path = tmp_path / "h.json"
    save_observations(rows, path)
    h = get_history("B0KEEPATEST", path)
    assert history_source(h) == "real"
    fc = forecast(h, float(h["price"].iloc[-1]), 14, 0.05, today="2026-10-24")
    assert fc["history_days"] > 1000 and fc["confidence"] in {"medium", "high"}


def test_real_history_replaces_simulated_rows_for_the_same_period(tmp_path):
    from app.fetch_history import history_rows
    path = tmp_path / "h.json"
    ensure_history("B0KEEPATEST", 100.0, path)                # simulated rows exist first
    assert history_source(get_history("B0KEEPATEST", path)) == "simulated"
    save_observations(history_rows(_keepa_item()), path)      # then real history arrives
    h = get_history("B0KEEPATEST", path)
    assert history_source(h) == "real"
    assert (h["source"] == "simulated").sum() == 0


def test_series_choice_prefers_the_one_with_real_coverage():
    from app.fetch_history import pick_series
    def pts(start, end, step):
        d = pd.date_range(start, end, freq=step)
        return [{"seen_at": x.strftime("%Y-%m-%dT%H:%M:%SZ"), "price": 50.0 + i % 7} for i, x in enumerate(d)]
    base = {"asin": "B0SERIESTST", "currency": "USD"}
    # buy box only covers 2 months, Amazon's own price covers 3 years -> Amazon wins
    item = {**base, "buybox_price_history": pts("2026-08-20", "2026-10-20", "3D"),
            "amazon_price_history": pts("2023-10-01", "2026-10-20", "7D")}
    assert pick_series(item)[0] == "amazon_price_history"
    # similar coverage -> the denser series wins
    item = {**base, "buybox_price_history": pts("2023-10-01", "2026-10-20", "30D"),
            "amazon_price_history": pts("2023-10-01", "2026-10-20", "7D")}
    assert pick_series(item)[0] == "amazon_price_history"
    # same coverage and density -> buy box (it matches the page price)
    item = {**base, "buybox_price_history": pts("2023-10-01", "2026-10-20", "7D"),
            "amazon_price_history": pts("2023-10-01", "2026-10-20", "7D")}
    assert pick_series(item)[0] == "buybox_price_history"
    # the lowest-any-seller series is only a fallback
    item = {**base, "new_price_history": pts("2023-10-01", "2026-10-20", "2D"),
            "buybox_price_history": pts("2023-10-01", "2026-10-20", "30D")}
    assert pick_series(item)[0] == "buybox_price_history"


def test_no_simulated_filler_when_there_is_enough_real_history(tmp_path):
    path = tmp_path / "h.json"
    rows = [_row("D", d.strftime("%Y-%m-%dT%H:%M:%SZ"), 40.0 + i % 5, "historical")
            for i, d in enumerate(pd.date_range("2026-07-01", "2026-10-20", freq="3D"))]
    save_observations(rows, path)                        # ~110 days of real history
    ensure_history("D", 40.0, path)
    h = get_history("D", path)
    assert set(h["source"]) == {"historical"} and history_source(h) == "real"


# ---------------------------------------------------------------- storage backends

def test_without_a_database_url_the_json_file_is_used(tmp_path, monkeypatch):
    monkeypatch.delenv("TIGER_DATABASE_URL", raising=False)
    monkeypatch.setattr(history_store, "HISTORY_PATH", tmp_path / "h.json")
    assert save_observations([_row("E", "2026-10-24T10:00:00Z", 10.0)]) == (1, 1)
    assert len(get_history("E")) == 1
    assert (tmp_path / "h.json").exists()


def test_unreachable_database_falls_back_to_the_json_file(tmp_path, monkeypatch):
    # a URL that cannot connect (or a missing driver) must never lose scraped data
    monkeypatch.setenv("TIGER_DATABASE_URL", "postgresql://nobody:x@127.0.0.1:1/none")
    monkeypatch.setattr(history_store, "HISTORY_PATH", tmp_path / "h.json")
    assert save_observations([_row("F", "2026-10-24T10:00:00Z", 10.0)]) == (1, 1)
    assert len(get_history("F")) == 1
    assert (tmp_path / "h.json").exists()


def test_an_explicit_path_always_uses_json_even_with_a_database_url(tmp_path, monkeypatch):
    monkeypatch.setenv("TIGER_DATABASE_URL", "postgresql://nobody:x@127.0.0.1:1/none")
    path = tmp_path / "explicit.json"
    assert save_observations([_row("G", "2026-10-24T10:00:00Z", 10.0)], path) == (1, 1)
    assert path.exists()


def test_database_rows_have_the_shape_the_store_expects():
    rows = history_store._db_rows([_row("H", "2026-10-24T10:00:00Z", 12.5)])
    assert rows == [("H", "2026-10-24T10:00:00Z", 12.5, "USD", "scraped", None, None)]
