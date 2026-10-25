
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.decision import decide, resolve_preferences
from app.forecast import forecast, history_source
from app.history_store import ensure_history, get_history
from app.schemas import PredictRequest, PredictResponse

app = FastAPI(
    title="WaitWise API",
    description="Price-drop predictions and deadline-aware buying advice",
    version="0.1.0",
)

# Lets the extension popup call this API. Tighten the regex to your
# extension's ID (chrome-extension://<id>) before any real deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://.*",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PREDICT_FILE = PROJECT_ROOT / "predict.json"


@app.get("/")
def home():
    return {
        "message": "Welcome to WaitWise API!",
        "status": "running",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/predict", response_model=PredictResponse)
def predict():
    try:
        with PREDICT_FILE.open("r", encoding="utf-8") as file:
            data = json.load(file)

        return PredictResponse.model_validate(data)

    except FileNotFoundError:
        raise HTTPException(
            status_code=500,
            detail="predict.json was not found",
        )
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=500,
            detail="predict.json contains invalid JSON",
        )
    except ValueError:
        raise HTTPException(
            status_code=500,
            detail="predict.json does not match the response schema",
        )


@app.post("/predict", response_model=PredictResponse)
def predict_for_product(req: PredictRequest):
    """Real forecast for the product the extension is looking at."""
    if req.currency.upper() != "USD":
        raise HTTPException(
            status_code=422,
            detail="Only USD prices are supported right now.",
        )

    prefs = resolve_preferences(
        req.preferences.model_dump() if req.preferences else None
    )

    # Adds LABELED simulated history if this product has too little real history.
    ensure_history(req.product_id, req.price)
    history = get_history(req.product_id)

    if history.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No history for product_id={req.product_id}",
        )

    fc = forecast(
        history,
        req.price,
        horizon_days=prefs["deadline_days"],
        drop_threshold=prefs["min_savings_pct"] / 100,
    )
    verdict = decide(fc, req.price, prefs)

    return PredictResponse(
        recommendation=verdict["recommendation"],
        p_drop=fc["p_drop"],
        expected_drop_pct=fc["expected_drop_pct"],
        expected_drop_usd=fc["expected_drop_usd"],
        interval_low_usd=fc["interval_low_usd"],
        interval_high_usd=fc["interval_high_usd"],
        predicted_low_usd=fc["predicted_low_usd"],
        confidence=fc["confidence"],
        best_day=verdict["best_day"],
        explanation=verdict["explanation"],
        data_source=history_source(history),
    )
