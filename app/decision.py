"""Turns a forecast plus the user's preferences into buy_now or wait.

The forecast never sees preferences. This layer applies them afterwards, so the
probabilities stay calibrated and the explanation can speak in the user's terms.
"""

RISK_THRESHOLDS = {"cautious": 0.80, "balanced": 0.65, "bold": 0.50}
DEFAULTS = {"risk_tolerance": "balanced", "min_savings_pct": 5.0,
            "deadline_days": 14, "budget_usd": None}


def resolve_preferences(prefs=None):
    merged = dict(DEFAULTS)
    merged.update({k: v for k, v in (prefs or {}).items() if v is not None})
    if merged["risk_tolerance"] not in RISK_THRESHOLDS:
        merged["risk_tolerance"] = "balanced"
    return merged


def decide(fc, current_price, prefs=None):
    """Returns {recommendation, best_day, explanation}."""
    p = resolve_preferences(prefs)
    need_p = RISK_THRESHOLDS[p["risk_tolerance"]]
    min_pct = float(p["min_savings_pct"])
    pct = round(fc["p_drop"] * 100)

    if not fc["enough_data"]:
        return {"recommendation": "buy_now", "best_day": None,
                "explanation": f"We only have {fc['history_days']} days of price history for this item, "
                               "so we can't forecast a drop. Treat this as a rough call."}

    if p["budget_usd"] is not None and current_price <= float(p["budget_usd"]):
        return {"recommendation": "buy_now", "best_day": None,
                "explanation": f"It is already within your ${float(p['budget_usd']):,.0f} budget, "
                               "so there is no need to wait."}

    worth_waiting = fc["expected_drop_pct"] >= min_pct
    likely_enough = fc["p_drop"] >= need_p
    if worth_waiting and likely_enough:
        return {"recommendation": "wait", "best_day": fc["best_day"],
                "explanation": f"There is a {pct}% chance of a drop of about {fc['expected_drop_pct']:.0f}% "
                               f"within {p['deadline_days']} days, which clears the {round(need_p * 100)}% "
                               f"bar for a {p['risk_tolerance']} shopper."}

    if not worth_waiting:
        why = (f"the typical drop (about {fc['expected_drop_pct']:.0f}%) is smaller than the "
               f"{min_pct:.0f}% you said is worth waiting for")
    else:
        why = (f"a drop is only {pct}% likely, below the {round(need_p * 100)}% "
               f"bar for a {p['risk_tolerance']} shopper")
    return {"recommendation": "buy_now", "best_day": None,
            "explanation": f"Buy now: {why}."}
