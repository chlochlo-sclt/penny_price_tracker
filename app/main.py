
import json
from datetime import date
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.current_price import current_price
from app.decision import decide, resolve_preferences
from app.forecast import forecast, history_source
from app.history_store import ensure_history, get_history
from app.live_fetch import ensure_real_history, history_status
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

BUY_REMINDER_DAYS = 3        # nudge this many days before the deadline

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

    # Starts a background Keepa fetch if we have no real history for this ASIN yet.
    status = ensure_real_history(req.product_id)

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
        history_status=status,
    )


@app.get("/watch-check/{product_id}")
def watch_check(product_id: str, target_price: float | None = None, deadline: str | None = None):
    """Today's price for a watched product, and whether it has hit the target.

    The watchlist calls this from a background alarm, when the user is not on the
    product page, so the price cannot come from the extension. One scrape per
    product per hour; the result is also appended to the product's history.

    buy_reminder is true within BUY_REMINDER_DAYS of the deadline, which is the
    "it never hit your target, buy it before you run out of time" nudge.
    """
    try:
        now = current_price(product_id)
    except Exception as err:
        raise HTTPException(status_code=503, detail=str(err))

    hit = target_price is not None and now["price"] <= target_price
    reminder = False
    days_left = None
    if deadline:
        try:
            left = (date.fromisoformat(deadline) - date.today()).days
            days_left = left
            reminder = not hit and left <= BUY_REMINDER_DAYS
        except ValueError:
            raise HTTPException(status_code=422, detail="deadline must be YYYY-MM-DD")

    return {**now, "target_price": target_price, "target_hit": hit,
            "days_left": days_left, "buy_reminder": reminder}


@app.get("/history-status/{product_id}")
def product_history_status(product_id: str):
    """Lightweight poll for the extension while real history is being fetched."""
    status = history_status(product_id)
    return {"product_id": product_id, "history_status": "unavailable" if status == "idle" else status}
