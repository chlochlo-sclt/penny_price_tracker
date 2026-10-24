
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from app.schemas import PredictResponse

app = FastAPI(
    title="WaitWise API",
    description="Price-drop predictions and deadline-aware buying advice",
    version="0.1.0",
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
