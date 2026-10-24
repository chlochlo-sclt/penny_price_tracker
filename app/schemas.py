from typing import Literal

from pydantic import BaseModel, Field


class Preferences(BaseModel):
    risk_tolerance: Literal["cautious", "balanced", "bold"] = "balanced"
    min_savings_pct: float = Field(default=5.0, ge=0)
    deadline_days: int = Field(default=14, ge=1, le=90)
    budget_usd: float | None = Field(default=None, ge=0)


class PredictRequest(BaseModel):
    product_id: str                 # the ASIN the extension reads from the page
    price: float = Field(gt=0)
    currency: str = "USD"           # only USD is supported for now
    title: str | None = None
    preferences: Preferences | None = None


class PredictResponse(BaseModel):
    recommendation: Literal["buy_now", "wait"]
    p_drop: float = Field(ge=0, le=1)
    expected_drop_pct: float = Field(ge=0)
    expected_drop_usd: float = Field(ge=0)
    interval_low_usd: float = Field(ge=0)
    interval_high_usd: float = Field(ge=0)
    confidence: Literal["low", "medium", "high"]
    best_day: str | None
    explanation: str
    # real = every row is an actual scrape; mixed = real + simulated;
    # simulated = all simulated; mock = the static predict.json
    data_source: Literal["real", "mixed", "simulated", "mock"]
