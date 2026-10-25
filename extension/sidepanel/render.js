// Rendering layer: turns data into what's on screen. These functions only
// fill in text, toggle the `hidden` attribute and swap CSS classes on the
// markup in sidepanel.html. All visual styling stays in sidepanel.css, which
// also shows every piece of text in lowercase.

const $ = (id) => document.getElementById(id);

const VIEWS = ["loading-view", "message-view", "recommendation-card"];

/** Shows one of the three main views and hides the other two. */
function showView(id) {
  for (const view of VIEWS) $(view).hidden = view !== id;
}

// ---- Formatting -----------------------------------------------------------

function formatMoney(value, currency = "USD") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    // Unknown currency code: show the number without a symbol.
    return value.toFixed(2);
  }
}

/** Whole dollars for amounts of $10 or more ("$115"), cents below that ("$6.25"). */
function formatMoneyShort(value, currency = "USD") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const digits = Math.abs(value) >= 10 ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return value.toFixed(digits);
  }
}

/** 0.72 → "72%" */
function formatProbability(fraction) {
  if (typeof fraction !== "number") return "—";
  return `${Math.round(fraction * 100)}%`;
}

/** 12.5 → "12.5%" */
function formatPercent(value) {
  if (typeof value !== "number") return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

// ---- Product summary ------------------------------------------------------

/** Shows the detected product's title and price at the top, or hides it if null. */
function renderProduct(product) {
  $("product-summary").hidden = !product;
  if (!product) return;
  $("product-title").textContent = product.title || "Untitled product";
  $("product-price").textContent =
    product.price != null ? formatMoney(product.price, product.currency ?? "USD") : "Price not shown";
}

// ---- Loading and message states -------------------------------------------

function renderLoading(text) {
  $("loading-text").textContent = text;
  showView("loading-view");
}

// Copy for every non-"ok" state. `tone` picks a CSS modifier class; `retry`
// shows a "Try again" button (the side panel stays open, so there's no
// "reopen" to retry with).
const MESSAGES = {
  not_product_page: {
    tone: "info",
    title: "Not a product page",
    text: "Open an Amazon product page to get a recommendation.",
  },
  no_content_script: {
    tone: "info",
    title: "Open an Amazon product page",
    text: "Recommendations work on amazon.com product pages. Already on one? Refresh the tab.",
    retry: true,
  },
  price_not_found: {
    tone: "warning",
    title: "Couldn't find the price",
    text: "We found the product but not its price. It may only appear after you pick a size or color, or only in the cart.",
  },
  unavailable: {
    tone: "warning",
    title: "Item unavailable",
    text: "This item isn't for sale right now, so there's no price to forecast.",
  },
  detection_error: {
    tone: "error",
    title: "Couldn't read this page",
    text: "Something went wrong reading the product. Try refreshing the page.",
    retry: true,
  },
  prediction_error: {
    tone: "error",
    title: "Couldn't load a recommendation",
    text: "Something went wrong getting the forecast. Try again in a moment.",
    retry: true,
  },
  backend_unreachable: {
    tone: "error",
    title: "Can't reach the forecast server",
    text: "Make sure the backend is running on 127.0.0.1:8000, then try again.",
    retry: true,
  },
  backend_timeout: {
    tone: "error",
    title: "The forecast is taking too long",
    text: "The server didn't answer within 10 seconds. Try again in a moment.",
    retry: true,
  },
  // `text` is replaced by the backend's own message when it sends one.
  backend_rejected: {
    tone: "warning",
    title: "Can't forecast this item",
    text: "The server couldn't use this product's details.",
  },
};

/** Shows a message state by key from MESSAGES; `text` overrides the default copy. */
function renderMessage(key, text = null) {
  const message = MESSAGES[key] ?? MESSAGES.detection_error;
  const view = $("message-view");
  view.className = `status-view status-view--${message.tone}`;
  $("message-title").textContent = message.title;
  $("message-text").textContent = text || message.text;
  $("message-retry").hidden = !message.retry;
  showView("message-view");
}

/** Maps an error from getPrediction (see PredictionError in api.js) to a message. */
function renderPredictionError(err) {
  if (err?.kind === "network") renderMessage("backend_unreachable");
  else if (err?.kind === "timeout") renderMessage("backend_timeout");
  else if (err?.kind === "rejected") renderMessage("backend_rejected", err.detail);
  else renderMessage("prediction_error");
}

/** Maps a non-"ok" detection result to the right message. */
function renderDetectionProblem(detection) {
  if (detection.status === "price_not_found") {
    renderMessage(detection.reason === "unavailable" ? "unavailable" : "price_not_found");
  } else if (detection.status === "page_loading") {
    renderLoading("Waiting for the page to finish loading…");
  } else if (detection.status === "error") {
    renderMessage("detection_error");
  } else {
    renderMessage(detection.status);
  }
}

// ---- Recommendation card --------------------------------------------------

const VERDICT_LABELS = { buy_now: "buy now", wait: "wait" };

/**
 * The backend returns p_drop 0 with low confidence when it has too little
 * history to forecast at all (enough_data = false in app/forecast.py).
 */
const isNotEnoughData = (prediction) => prediction.p_drop === 0 && prediction.confidence === "low";

/**
 * The hero line: "62% chance you'll save $115+ (10%) by Nov 27". p_drop is
 * the chance the price falls at least min_savings_pct below today's within
 * deadline_days (see app/forecast.py), so the line describes the request
 * that produced this prediction, not wherever the sliders are now.
 */
function renderChanceLine(prediction, request) {
  const line = $("recommendation-result");
  const { min_savings_pct: pct, deadline_days: days } = request.preferences;
  if (isNotEnoughData(prediction)) {
    line.className = "chance-line chance-line--no-data";
    line.textContent = "Not enough price history to estimate the chance of a drop yet.";
    return;
  }
  line.className = "chance-line";
  const chance = document.createElement("span");
  chance.className = "chance-line-pct";
  chance.textContent = formatProbability(prediction.p_drop);
  const by = formatShortDate(addDays(startOfDay(), days));
  const amount = document.createElement("strong");
  amount.className = "chance-line-amount";
  amount.textContent = `${formatMoneyShort((request.price * pct) / 100, request.currency)}+`;
  line.replaceChildren(chance, " chance you'll save ", amount, ` (${pct}%) by ${by}.`);
}

/** "predicted lowest price: $259.04 on Oct 28" (or "… today"), from predicted_low_usd and best_day. */
function renderPredictedLow(prediction, request) {
  const line = $("predicted-low-line");
  const low = prediction.predicted_low_usd;
  line.hidden = !Number.isFinite(low); // the schema allows null
  if (line.hidden) return;
  const when = prediction.best_day === toIsoDate(new Date())
    ? "today"
    : `on ${formatShortDate(parseIsoDate(prediction.best_day))}`;
  line.textContent = `predicted lowest price: ${formatMoney(low, request.currency)} ${when}`;
}

/** Shows or hides the subtle "Updating…" state while the sliders' request runs. */
function renderUpdating(isUpdating) {
  $("recommendation-card").classList.toggle("recommendation-card--updating", isUpdating);
  // A small badge floating inside the chance plate: it takes no space, so
  // nothing below moves. sidepanel.css only shows it (and dims the result)
  // if the request takes longer than 200 ms, so fast answers don't flash.
  $("updating-indicator").textContent = isUpdating ? "updating…" : "";
  // A finished request clears an earlier "couldn't update" line.
  if (!isUpdating) $("recommendation-status").hidden = true;
}

/** A slider-triggered request failed: keep the last result, say it's out of date. */
function renderUpdateError(err) {
  renderUpdating(false);
  const status = $("recommendation-status");
  const reason =
    err?.kind === "network" ? "can't reach the forecast server"
      : err?.kind === "timeout" ? "the server took too long"
        : err?.kind === "rejected" && err.detail ? err.detail
          : "something went wrong";
  status.className = "recommendation-status recommendation-status--error";
  status.textContent = `Couldn't update: ${reason}. Showing the last result.`;
  status.hidden = false;
}

/**
 * The verdict, always the same height (sidepanel.css), so nothing below it
 * moves when it changes:
 *   not leaning  "wait" or "buy now" on one line, large
 *   leaning      "leaning" large, and beside it the verdict words smaller and
 *                stacked ("buy" above "now"), exactly as tall as "leaning";
 *                a single word ("wait") is centered in that space
 * A short fade plays only when the verdict actually changes.
 */
function renderVerdict(verdict, isLeaning) {
  const el = $("verdict");
  const span = (className, text) => {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  };
  if (isLeaning) {
    const stack = span("verdict-stack", "");
    const words = verdict.split(" ").map((w) => span("verdict-stack-word", w));
    // Spaces keep the text "leaning buy now" for screen readers.
    stack.replaceChildren(...words.flatMap((w, i) => (i ? [" ", w] : [w])));
    el.replaceChildren(span("verdict-main", "leaning"), " ", stack);
  } else {
    el.replaceChildren(span("verdict-main", verdict));
  }
  el.classList.toggle("verdict--leaning", isLeaning);

  const key = `${isLeaning ? "leaning " : ""}${verdict}`;
  if (el.dataset.verdict && el.dataset.verdict !== key) {
    el.classList.remove("verdict--changed");
    void el.offsetWidth; // restart the fade
    el.classList.add("verdict--changed");
    el.addEventListener("animationend", () => el.classList.remove("verdict--changed"), { once: true });
  }
  el.dataset.verdict = key;
}

/**
 * What the numbers are based on, whenever that isn't all real price history.
 * This is the only place the data source is shown, so it must never let
 * simulated numbers read as real history.
 */
const DATA_SOURCE_NOTES = {
  simulated: "real price history isn't available for this item. this estimate uses simulated prices, not real price history.",
  mixed: "only part of this item's price history is real. this estimate is partly based on simulated prices.",
  mock: "these are mock numbers for testing.",
};

// Short versions, after a "loading…" / "couldn't load…" sentence.
const DATA_SOURCE_FOLLOW_UPS = {
  simulated: "for now, this estimate uses simulated prices, not real price history.",
  mixed: "for now, this estimate is partly based on simulated prices.",
  mock: "these are mock numbers for testing.",
};

/**
 * The small note under the chance line. `state` comes from sidepanel.js
 * (see HISTORY_RETRY there): "fetching" (real history is loading),
 * "gave_up" (still loading after the poll limit, or a re-request failed), or
 * null. Without a state, it shows the data-source note, if any.
 */
function renderHistoryNotice(state, dataSource = null) {
  const notice = $("history-notice");
  const lead = { fetching: "loading real price history…", gave_up: "couldn't load real price history yet." }[state];
  const text = lead
    ? [lead, DATA_SOURCE_FOLLOW_UPS[dataSource]].filter(Boolean).join(" ")
    : DATA_SOURCE_NOTES[dataSource];
  notice.hidden = !text;
  notice.className = `history-notice history-notice--${state === "fetching" ? "fetching" : "static"}`;
  $("history-notice-text").textContent = text ?? "";
}

/**
 * Fills in the card from a prediction (field names match mock/predict.json).
 * `request` is what was asked: { preferences, price, currency }.
 */
function renderRecommendation(prediction, request) {
  const isLowConfidence = prediction.confidence === "low";
  const verdict = VERDICT_LABELS[prediction.recommendation];

  // The modifier classes pick the verdict's color: "wait" in the text color,
  // "buy now" in emerald, and any "leaning …" verdict in grey.
  const card = $("recommendation-card");
  card.className = "recommendation-card";
  card.classList.add(`recommendation-card--${prediction.recommendation.replace("_", "-")}`);
  card.classList.toggle("recommendation-card--low-confidence", isLowConfidence);

  renderVerdict(verdict, isLowConfidence);
  renderChanceLine(prediction, request);
  renderPredictedLow(prediction, request);
  renderUpdating(false);
  renderHistoryNotice(null, prediction.data_source);

  // "why?" panel: the backend's own explanation. The expected drop appears
  // only on a wait card; on buy now it would sit next to the predicted
  // lowest price and look contradictory.
  $("explanation").textContent = prediction.explanation ?? "";
  const isWait = prediction.recommendation === "wait";
  $("expected-savings-row").hidden = !isWait;
  $("expected-savings").textContent = isWait
    ? `${formatPercent(prediction.expected_drop_pct)} (${formatMoney(prediction.expected_drop_usd)})`
    : "";
  $("forecast-reliability").textContent = `forecast reliability: ${prediction.confidence}`;

  showView("recommendation-card");
}
