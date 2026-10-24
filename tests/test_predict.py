
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
        "confidence",
        "best_day",
        "explanation",
        "data_source",
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
