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


CLUSTERED = 0.35        # low timings this concentrated make the date worth naming
LOOSE = 0.12            # below this they are spread right across the window
MEANINGFUL_SAVING = 0.01   # a predicted low this close to today's price isn't news


def _low_price_text(fc, current_price, target):
    """The headline number: what you'd likely pay, and when.

    Uses the predicted low when it is actually below today's price; otherwise the
    user's own target, since quoting a "low" equal to today's price reads as a bug.
    """
    low = fc.get("predicted_low_usd")
    price = float(current_price)
    if low and low < price * (1 - MEANINGFUL_SAVING):
        return f"about ${low:,.2f}"
    return f"about ${target:,.2f}"


def _when_text(fc, days):
    """Short version of when the low lands, and how much to trust it."""
    day = fc.get("likely_low_day")
    if not day:
        return f"within {days} days"
    when = _date_text(day)
    cal = fc.get("low_day_reason")
    if cal:
        return (f"around {when} (cheapest then in {cal['years_below']} of the last "
                f"{cal['years']} years)")
    strength = fc.get("low_day_strength") or 0.0
    if strength >= CLUSTERED:
        return f"around {when}"
    if fc.get("low_day_half") == "late":
        return f"later in your {days} days"
    if fc.get("low_day_half") == "early":
        return f"earlier in your {days} days"
    return f"any time in your {days} days"


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
        text = (f"Wait — likely {_low_price_text(fc, current_price, target)} "
                f"{_when_text(fc, days)}. "
                f"{chance}% of past {days}-day windows dropped {want_pct:g}%+, "
                f"over your {need_pct:g}% threshold.")
        return {"recommendation": "wait", "best_day": day, "explanation": text}

    return {"recommendation": "buy_now", "best_day": today,
            "explanation": f"Buy now — only {chance}% of past {days}-day windows dropped "
                           f"{want_pct:g}%+, under your {need_pct:g}% threshold."}
