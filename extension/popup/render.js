// Rendering layer: turns data into what's on screen. These functions only
// fill in text, toggle the `hidden` attribute and swap CSS classes on the
// markup in popup.html. All visual styling stays in popup.css.

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

// Copy for every non-"ok" state. `tone` picks a CSS modifier class.
const MESSAGES = {
  not_product_page: {
    tone: "info",
    title: "Not a product page",
    text: "Open an Amazon product page to get a recommendation.",
  },
  no_content_script: {
    tone: "info",
    title: "Open an Amazon product page",
    text: "Recommendations work on amazon.com product pages. Already on one? Refresh the tab and try again.",
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
  },
  prediction_error: {
    tone: "error",
    title: "Couldn't load a recommendation",
    text: "Something went wrong getting the forecast. Try again in a moment.",
  },
};

/** Shows a message state by key from MESSAGES. */
function renderMessage(key) {
  const message = MESSAGES[key] ?? MESSAGES.detection_error;
  const view = $("message-view");
  view.className = `status-view status-view--${message.tone}`;
  $("message-title").textContent = message.title;
  $("message-text").textContent = message.text;
  showView("message-view");
}

/** Maps a non-"ok" detection result to the right message. */
function renderDetectionProblem(detection) {
  if (detection.status === "price_not_found") {
    renderMessage(detection.reason === "unavailable" ? "unavailable" : "price_not_found");
  } else if (detection.status === "error") {
    renderMessage("detection_error");
  } else {
    renderMessage(detection.status);
  }
}

// ---- Recommendation card --------------------------------------------------

const VERDICT_LABELS = { buy_now: "Buy now", wait: "Wait" };

/** Fills in the card from a prediction (field names match mock/predict.json). */
function renderRecommendation(prediction) {
  const isLowConfidence = prediction.confidence === "low";
  const verdict = VERDICT_LABELS[prediction.recommendation];

  const card = $("recommendation-card");
  card.className = "recommendation-card";
  card.classList.add(`recommendation-card--${prediction.recommendation.replace("_", "-")}`);
  card.classList.toggle("recommendation-card--low-confidence", isLowConfidence);

  // With low confidence the verdict is softened so it doesn't read as certain.
  $("low-confidence-notice").hidden = !isLowConfidence;
  $("verdict").textContent = isLowConfidence ? `Leaning “${verdict}”` : verdict;

  $("p-drop").textContent = formatProbability(prediction.p_drop);
  $("expected-savings").textContent =
    `${formatPercent(prediction.expected_drop_pct)} (${formatMoney(prediction.expected_drop_usd)})`;
  $("price-interval").textContent =
    `${formatMoney(prediction.interval_low_usd)} – ${formatMoney(prediction.interval_high_usd)}`;

  const confidence = $("confidence");
  confidence.textContent = prediction.confidence;
  confidence.className = `confidence-badge confidence-badge--${prediction.confidence}`;

  $("best-day-row").hidden = !prediction.best_day;
  if (prediction.best_day) $("best-day").textContent = formatDay(prediction.best_day);

  $("explanation").textContent = prediction.explanation ?? "";
  $("simulated-label").hidden = prediction.data_source !== "simulated";

  showView("recommendation-card");
}
