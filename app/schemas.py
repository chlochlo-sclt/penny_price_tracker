
from typing import Literal

from pydantic import BaseModel, Field


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
    data_source: Literal[
        "historical", "scraped", "simulated", "mock", "mixed"
    ]
