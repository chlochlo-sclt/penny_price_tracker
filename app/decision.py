"""Turns a forecast plus the user's three settings into buy_now or wait.

The user chooses:
  min_savings_pct     how much cheaper than today's price they want to get
  min_confidence_pct  how sure we have to be that it will get there
  deadline_days       the latest they are willing to buy

The forecast never sees the confidence setting. This layer applies it afterwards,
so the probabilities stay calibrated and the explanation can speak in the user's terms.
"""

# Optional shortcuts the extension can send instead of a number.
CONFIDENCE_PRESETS = {"cautious": 80.0, "balanced": 65.0, "bold": 50.0}
DEFAULTS = {"min_savings_pct": 5.0, "min_confidence_pct": 65.0, "deadline_days": 14}


def resolve_preferences(prefs=None):
    given = {k: v for k, v in (prefs or {}).items() if v is not None}
    merged = dict(DEFAULTS)
    merged.update({k: given[k] for k in DEFAULTS if k in given})
    if "min_confidence_pct" not in given and given.get("risk_tolerance") in CONFIDENCE_PRESETS:
        merged["min_confidence_pct"] = CONFIDENCE_PRESETS[given["risk_tolerance"]]
    return merged


def _date_text(iso):
    from datetime import date
    d = date.fromisoformat(iso)
    return f"{d.strftime('%b')} {d.day}"


def decide(fc, current_price, prefs=None):
    """Returns {recommendation, best_day, explanation}. best_day is always set."""
    p = resolve_preferences(prefs)
    want_pct = float(p["min_savings_pct"])
    need_pct = float(p["min_confidence_pct"])
    days = int(p["deadline_days"])
    today = fc["today"]

    if not fc["enough_data"]:
        return {"recommendation": "buy_now", "best_day": today,
                "explanation": f"We only have {fc['history_days']} days of price history for this item, "
                               "so we can't forecast a drop. Treat this as a rough call."}

    chance = round(fc["p_drop"] * 100)
    target = float(current_price) * (1 - want_pct / 100)

    if chance >= need_pct:
        day = fc["likely_low_day"] or today
        text = (f"Wait: in about {chance}% of comparable past {days}-day windows the price fell at least "
                f"{want_pct:g}% (to about ${target:,.2f} or lower), which meets your "
                f"{need_pct:g}% confidence level.")
        if fc["likely_low_day"]:
            text += f" The lowest price most often comes around {_date_text(day)}."
        return {"recommendation": "wait", "best_day": day, "explanation": text}

    return {"recommendation": "buy_now", "best_day": today,
            "explanation": f"Buy now: in only about {chance}% of comparable past {days}-day windows did the price "
                           f"fall {want_pct:g}% or more, below your {need_pct:g}% confidence level."}
