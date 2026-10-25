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


def _fc(p_drop=0.70, likely_low_day="2026-11-27"):
    return {"p_drop": p_drop, "expected_drop_pct": 10.0, "expected_drop_usd": 10.0,
            "interval_low_usd": 88.0, "interval_high_usd": 100.0, "predicted_low_usd": 92.0,
            "today": "2026-10-24", "likely_low_day": likely_low_day,
            "history_days": 365, "enough_data": True}


def test_confidence_level_changes_the_verdict():
    base = {"min_savings_pct": 10, "deadline_days": 35}
    wait = decide(_fc(0.70), 100.0, {**base, "min_confidence_pct": 65})
    assert wait["recommendation"] == "wait" and wait["best_day"] == "2026-11-27"
    assert "70%" in wait["explanation"] and "65%" in wait["explanation"]
    buy = decide(_fc(0.70), 100.0, {**base, "min_confidence_pct": 85})
    assert buy["recommendation"] == "buy_now" and buy["best_day"] == "2026-10-24"   # best day is always set
    assert "85%" in buy["explanation"]


def test_risk_presets_are_shortcuts_for_the_confidence_number():
    from app.decision import resolve_preferences
    assert resolve_preferences({"risk_tolerance": "cautious"})["min_confidence_pct"] == 80
    assert resolve_preferences({"risk_tolerance": "bold"})["min_confidence_pct"] == 50
    # an explicit number wins over the preset
    assert resolve_preferences({"risk_tolerance": "bold", "min_confidence_pct": 90})["min_confidence_pct"] == 90
    assert resolve_preferences(None)["min_confidence_pct"] == 65


def test_there_is_no_budget_setting():
    from app.decision import resolve_preferences
    assert "budget_usd" not in resolve_preferences({"budget_usd": 50})


def test_wait_verdict_without_a_known_low_day_still_gives_a_best_day():
    d = decide(_fc(0.9, likely_low_day=None), 100.0, {"min_confidence_pct": 65})
    assert d["recommendation"] == "wait" and d["best_day"] == "2026-10-24"


def test_forecast_reports_predicted_low_and_likely_day(tmp_path):
    path = tmp_path / "h.json"
    ensure_history("P", 200.0, path)
    fc = forecast(get_history("P", path), 200.0, 35, 0.05, today="2026-10-24")
    assert fc["interval_low_usd"] <= fc["predicted_low_usd"] <= fc["interval_high_usd"] <= 200.0
    if fc["likely_low_day"]:
        assert "2026-10-24" < fc["likely_low_day"] <= "2026-11-28"      # inside the 35-day deadline


def test_a_price_that_never_changes_gets_no_wait_verdict():
    flat = pd.DataFrame({"timestamp": pd.date_range("2023-01-01", "2026-10-23", freq="D").strftime("%Y-%m-%dT00:00:00Z"),
                         "price": 12.0, "source": "historical"})
    fc = forecast(flat, 12.0, 35, 0.05, today="2026-10-24")
    d = decide(fc, 12.0, {"deadline_days": 35})
    assert fc["p_drop"] == 0 and d["recommendation"] == "buy_now" and d["best_day"] == "2026-10-24"


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


# ---- backtest ----
def _sim(days=800):
    from app.history import simulate_history
    h = simulate_history("SIMBT", 150.0, "2026-10-23", days=days)
    h["source"] = "simulated"
    return h


def test_backtest_basic_shape():
    from app.backtest import backtest
    r = backtest(_sim(), deadline_days=14, savings_pct=5.0)
    s = r["summary"]
    assert s["n"] > 50
    assert all(0.0 <= row["p_drop"] <= 1.0 for row in r["rows"])
    assert 0.0 <= s["brier"] <= 1.0


def test_backtest_has_no_lookahead():
    """Changing prices after a cutoff must not change predictions made before it."""
    import pandas as pd
    from app.backtest import backtest
    h = _sim()
    a = backtest(h, 14, 5.0)["rows"]
    cutoff = pd.to_datetime(a[len(a) // 2]["date"])
    h2 = h.copy()
    ts = pd.to_datetime(h2["timestamp"], utc=True).dt.tz_localize(None)
    h2.loc[ts > cutoff + pd.Timedelta(days=14), "price"] *= 0.5
    b = backtest(h2, 14, 5.0)["rows"]
    early_a = [r["p_drop"] for r in a if pd.to_datetime(r["date"]) <= cutoff]
    early_b = [r["p_drop"] for r in b if pd.to_datetime(r["date"]) <= cutoff]
    assert early_a == early_b


# ---- live fetch ----
def _live(real_days=0, worker=None, token="x"):
    """Context-free helper: patch live_fetch for one test, return an undo function."""
    import os
    from app import live_fetch as lf
    saved = (lf.real_span_days, lf.worker, os.environ.get("APIFY_API_TOKEN"), dict(lf._state))
    lf.real_span_days = lambda pid, path=None: real_days
    lf.worker = worker or (lambda asin: None)
    if token:
        os.environ["APIFY_API_TOKEN"] = token
    else:
        os.environ.pop("APIFY_API_TOKEN", None)
    lf._state.clear()

    def undo():
        lf.real_span_days, lf.worker = saved[0], saved[1]
        if saved[2] is None:
            os.environ.pop("APIFY_API_TOKEN", None)
        else:
            os.environ["APIFY_API_TOKEN"] = saved[2]
        lf._state.clear(); lf._state.update(saved[3])
    return lf, undo


def test_live_fetch_starts_when_no_real_history():
    calls = []
    lf, undo = _live(worker=lambda asin: calls.append(asin))
    try:
        lf.ensure_real_history("B0TESTASIN", background=False)
        assert calls == ["B0TESTASIN"]
    finally:
        undo()


def test_live_fetch_skipped_when_history_already_real():
    calls = []
    lf, undo = _live(real_days=400, worker=lambda asin: calls.append(asin))
    try:
        assert lf.ensure_real_history("B0TESTASIN", background=False) == "ready"
        assert calls == []
    finally:
        undo()


def test_live_fetch_failure_is_reported_and_not_retried_immediately():
    calls = []

    def boom(asin):
        calls.append(asin)
        raise RuntimeError("quota")
    lf, undo = _live(worker=boom)
    try:
        assert lf.ensure_real_history("B0TESTASIN", background=False) == "failed"
        assert lf.ensure_real_history("B0TESTASIN", background=False) == "failed"
        assert len(calls) == 1          # cooldown: second call did not refetch
    finally:
        undo()


def test_live_fetch_unavailable_without_token_or_for_non_asin():
    lf, undo = _live(token=None)
    try:
        assert lf.ensure_real_history("B0TESTASIN", background=False) == "unavailable"
    finally:
        undo()
    lf, undo = _live()
    try:
        assert lf.ensure_real_history("not an asin!", background=False) == "unavailable"
    finally:
        undo()


def test_outlier_flicker_is_removed():
    import pandas as pd
    from app.forecast import clean_outliers, daily_series
    ts = pd.date_range("2026-01-01", periods=120, freq="D").strftime("%Y-%m-%dT12:00:00Z")
    prices = [260.0] * 120
    prices[100] = 99.99
    prices[119] = 99.99
    h = pd.DataFrame({"timestamp": ts, "price": prices, "source": "historical"})
    assert len(clean_outliers(h)) == 118
    assert daily_series(h).min() == 260.0


def test_confidence_is_capped_without_a_proven_signal():
    from app.forecast import _confidence
    assert _confidence(400, 40, has_proven_signal=True) == "high"
    assert _confidence(400, 40, has_proven_signal=False) == "medium"
    assert _confidence(30, 1, has_proven_signal=True) == "low"
