
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_home():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["status"] == "running"


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_predict_response():
    response = client.get("/predict")

    assert response.status_code == 200

    data = response.json()

    expected_fields = {
        "recommendation",
        "p_drop",
        "expected_drop_pct",
        "expected_drop_usd",
        "interval_low_usd",
        "interval_high_usd",
        "predicted_low_usd",
        "confidence",
        "best_day",
        "explanation",
        "data_source",
        "history_status",
    }

    assert set(data.keys()) == expected_fields
    assert data["recommendation"] in ["buy_now", "wait"]
    assert 0 <= data["p_drop"] <= 1
    assert data["confidence"] in ["low", "medium", "high"]
    assert data["data_source"] == "simulated"
    assert data["best_day"] == "2026-11-27"


def test_predict_probability_is_a_decimal():
    data = client.get("/predict").json()
    assert data["p_drop"] == 0.72


def test_predict_expected_drop():
    data = client.get("/predict").json()
    assert data["expected_drop_usd"] == 15.0
    assert data["expected_drop_pct"] == 12.5


def test_post_predict_uses_real_history(tmp_path, monkeypatch):
    from app import history_store
    monkeypatch.delenv("TIGER_DATABASE_URL", raising=False)   # tests never touch the real database
    monkeypatch.setattr(history_store, "HISTORY_PATH", tmp_path / "h.json")

    body = {"product_id": "B0TESTASIN1", "price": 120.0, "currency": "USD",
            "preferences": {"risk_tolerance": "bold", "deadline_days": 35}}
    data = client.post("/predict", json=body).json()

    assert data["recommendation"] in ["buy_now", "wait"]
    assert data["data_source"] == "simulated"          # nothing scraped for this ID
    assert 0 <= data["p_drop"] <= 1


def test_post_predict_rejects_non_usd(tmp_path, monkeypatch):
    from app import history_store
    monkeypatch.delenv("TIGER_DATABASE_URL", raising=False)   # tests never touch the real database
    monkeypatch.setattr(history_store, "HISTORY_PATH", tmp_path / "h.json")

    body = {"product_id": "B0TESTASIN1", "price": 99.0, "currency": "EUR"}
    assert client.post("/predict", json=body).status_code == 422


def test_cors_allows_extension_origin():
    response = client.options(
        "/predict",
        headers={
            "Origin": "chrome-extension://abcdefghijklmnop",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.headers["access-control-allow-origin"] == "chrome-extension://abcdefghijklmnop"


def test_post_predict_accepts_savings_confidence_and_deadline(tmp_path, monkeypatch):
    from app import history_store
    monkeypatch.delenv("TIGER_DATABASE_URL", raising=False)   # tests never touch the real database
    monkeypatch.setattr(history_store, "HISTORY_PATH", tmp_path / "h.json")

    body = {"product_id": "B0TESTASIN2", "price": 120.0, "currency": "USD",
            "preferences": {"min_savings_pct": 10, "min_confidence_pct": 60, "deadline_days": 35}}
    data = client.post("/predict", json=body).json()

    assert data["recommendation"] in ["buy_now", "wait"]
    assert data["best_day"]                       # always present
    assert data["predicted_low_usd"] <= 120.0
    assert "60%" in data["explanation"]


def test_post_predict_rejects_out_of_range_settings():
    body = {"product_id": "B0TESTASIN2", "price": 120.0,
            "preferences": {"min_confidence_pct": 20}}
    assert client.post("/predict", json=body).status_code == 422


def test_watch_check_reports_target_hit_and_buy_reminder(monkeypatch):
    """The watchlist's two jobs: target reached, and nudge before the deadline."""
    from datetime import date, timedelta
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "current_price", lambda pid: {
        "asin": pid, "price": 17.0, "currency": "USD", "title": "T",
        "as_of": "2026-10-24T10:00:00Z", "cached": False})

    hit = client.get("/watch-check/B00TTD9BRC", params={"target_price": 18.0}).json()
    assert hit["target_hit"] is True

    soon = (date.today() + timedelta(days=2)).isoformat()
    miss = client.get("/watch-check/B00TTD9BRC",
                      params={"target_price": 5.0, "deadline": soon}).json()
    assert miss["target_hit"] is False
    assert miss["buy_reminder"] is True          # deadline is 2 days away

    later = (date.today() + timedelta(days=30)).isoformat()
    early = client.get("/watch-check/B00TTD9BRC",
                       params={"target_price": 5.0, "deadline": later}).json()
    assert early["buy_reminder"] is False


def test_watch_check_rejects_a_bad_deadline(monkeypatch):
    from app import main as main_mod
    monkeypatch.setattr(main_mod, "current_price", lambda pid: {
        "asin": pid, "price": 17.0, "currency": "USD", "title": "T",
        "as_of": "2026-10-24T10:00:00Z", "cached": False})
    r = client.get("/watch-check/B00TTD9BRC", params={"deadline": "next tuesday"})
    assert r.status_code == 422
