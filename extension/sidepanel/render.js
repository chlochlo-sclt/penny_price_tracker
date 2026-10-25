// Rendering layer: turns data into what's on screen. These functions only
// fill in text, toggle the `hidden` attribute and swap CSS classes on the
// markup in sidepanel.html. All visual styling stays in sidepanel.css, which
// also shows every piece of text in lowercase.

const $ = (id) => document.getElementById(id);

const VIEWS = ["loading-view", "message-view", "recommendation-card"];

/** Shows one of the three main views and hides the other two. */
function showView(id) {
  for (const view of VIEWS) $(view).hidden = view !== id;
  // The price range only makes sense next to a forecast.
  if (id !== "recommendation-card") $("price-range").hidden = true;
  syncDetailsCard();
}

/**
 * The "details" card holds the price range and the watch list; it's shown
 * when either has something to show (watchlist-ui.js calls this too).
 */
function syncDetailsCard() {
  $("details-card").hidden = $("price-range").hidden && $("watchlist").hidden;
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

/** "2026-11-27" → "Fri, Nov 27". */
function formatDay(isoDate) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  // Build the date from parts so it's local midnight. new Date("2026-11-27")
  // would be UTC midnight, which shows as the previous day in US time zones.
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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

// Chip text for each data_source value in app/schemas.py.
const DATA_SOURCE_LABELS = {
  real: "real price data",
  mixed: "partly simulated data",
  simulated: "simulated data",
  mock: "mock data",
};

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

/** Shows or hides the subtle "Updating…" state while the sliders' request runs. */
function renderUpdating(isUpdating) {
  $("recommendation-card").classList.toggle("recommendation-card--updating", isUpdating);
  const status = $("recommendation-status");
  status.className = "recommendation-status";
  status.textContent = isUpdating ? "Updating…" : "";
  status.hidden = !isUpdating;
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
 * Likely best price before the deadline (interval_low_usd–interval_high_usd,
 * the 10th–90th percentile of the lowest price; the high end is capped at
 * today's price) as a bar, with today's price and the most likely lowest
 * price (predicted_low_usd, the median) marked. Positions are passed to
 * sidepanel.css as fractions of the bar's width.
 */
function renderPriceRange(prediction, request) {
  const low = prediction.interval_low_usd;
  const high = prediction.interval_high_usd;
  const today = request.price;
  const section = $("price-range");
  const usable = [low, high, today].every(Number.isFinite) && high > low && !isNotEnoughData(prediction);
  section.hidden = !usable;
  if (!usable) return;

  // predicted_low_usd may be null (the schema allows it); then no marker.
  const predicted = Number.isFinite(prediction.predicted_low_usd) ? prediction.predicted_low_usd : null;
  const values = [low, high, today, ...(predicted != null ? [predicted] : [])];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const position = (value) => ((value - min) / (max - min)).toFixed(4);
  // Set on the section so the bar and the labels under it share them.
  const bar = $("price-range-bar");
  section.style.setProperty("--band-start", position(low));
  section.style.setProperty("--band-end", position(high));
  section.style.setProperty("--today", position(today));
  $("price-range-predicted").hidden = predicted == null;
  $("price-range-predicted-label").hidden = predicted == null;
  if (predicted != null) {
    section.style.setProperty("--predicted", position(predicted));
    $("price-range-predicted-value").textContent = formatMoney(predicted);
  }
  bar.setAttribute(
    "aria-label",
    `likely best price between ${formatMoney(low)} and ${formatMoney(high)}` +
      (predicted != null ? `, most likely lowest ${formatMoney(predicted)}` : "") +
      `; today's price is ${formatMoney(today)}`,
  );

  // Under the bar: the band's two ends, each under its own end. Above: today.
  $("price-range-low").textContent = formatMoney(low);
  $("best-price-range").textContent = formatMoney(high);
  $("price-range-today-label").textContent = `today ${formatMoney(today)}`;
}

/** best_day is always set by the backend: today when buying now is best. */
function formatBestDay(isoDate) {
  return isoDate === toIsoDate(new Date()) ? `today (${formatDay(isoDate)})` : formatDay(isoDate);
}

// The small line under the chance line about real price history, keyed by
// the state sidepanel.js tracks (see HISTORY_RETRY there).
const HISTORY_NOTICES = {
  fetching: "Loading real price history…",
  gave_up: "Couldn't load real history yet. This estimate uses simulated prices.",
  failed: "Couldn't load real history yet. This estimate uses simulated prices.",
};

/** Shows or hides the history notice; `state` is a HISTORY_NOTICES key or null. */
function renderHistoryNotice(state) {
  const notice = $("history-notice");
  const text = HISTORY_NOTICES[state];
  notice.hidden = !text;
  notice.className = `history-notice history-notice--${state === "fetching" ? "fetching" : "unavailable"}`;
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

  // With low confidence the verdict is softened so it doesn't read as certain.
  $("verdict").textContent = isLowConfidence ? `leaning ${verdict}` : verdict;

  renderChanceLine(prediction, request);
  renderUpdating(false);

  // Chips: the backend's confidence and data_source
  const confidence = $("confidence");
  confidence.textContent = `${prediction.confidence} confidence`;
  confidence.className = `chip chip--confidence chip--confidence-${prediction.confidence}`;
  const sourceEl = $("data-source-label");
  sourceEl.textContent = DATA_SOURCE_LABELS[prediction.data_source];
  sourceEl.className = `chip chip--source chip--source-${prediction.data_source}`;

  // "why?" panel: the backend's own explanation
  $("explanation").textContent = prediction.explanation ?? "";
  $("expected-savings").textContent =
    `${formatPercent(prediction.expected_drop_pct)} (${formatMoney(prediction.expected_drop_usd)})`;
  $("best-day").textContent = formatBestDay(prediction.best_day);

  showView("recommendation-card");
  renderPriceRange(prediction, request);
  syncDetailsCard();
}
