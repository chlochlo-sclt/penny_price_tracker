// Data layer: where the side panel's data comes from. Nothing here touches the
// DOM; render.js does all the drawing and sidepanel.js connects the two.
// API_BASE_URL and REQUEST_TIMEOUT_MS live in shared/config.js.

/** The tab the side panel is showing: the active tab in the panel's own window. */
async function getActiveTab() {
  if (!globalThis.chrome?.tabs) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/**
 * Asks the active tab's content script what product it sees.
 * Always resolves with a detection result (see content/content.js), plus:
 *   status "page_loading"       nothing answered yet but the tab is still
 *                               loading; the content script announces itself
 *                               when ready and the panel re-runs (sidepanel.js)
 *   status "no_content_script"  nothing on the tab answered
 */
async function getDetection() {
  // No chrome.tabs: the panel was opened as a plain web page (e.g. for previewing).
  const tab = await getActiveTab();
  if (!tab?.id) return { status: "no_content_script", product: null };

  // Ask first, whatever the tab's status: Amazon pages report "loading" for
  // a long time (ads, iframes) after the content script is already ready.
  // Right after a load finishes it may not be listening yet, so retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_PRODUCT" });
      if (result) return result;
    } catch {
      // Chrome rejects with "Receiving end does not exist" when no content
      // script is listening: a non-Amazon site, a chrome:// page, a page
      // that's still loading, or an Amazon tab opened before the extension
      // was (re)loaded.
    }
    const latest = await chrome.tabs.get(tab.id).catch(() => null);
    if (latest?.status === "loading") return { status: "page_loading", product: null };
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { status: "no_content_script", product: null };
}

/** "Buy now": asks the page to scroll its own buy button into view. */
async function scrollPageToBuyButton() {
  const tab = await getActiveTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "SCROLL_TO_BUY" });
  } catch {
    return null;
  }
}

/**
 * The full Preferences object for app/schemas.py, built from the slider
 * values. There's no UI for risk tolerance or budget, so those are fixed.
 */
function getPreferences({ min_savings_pct, deadline_days }) {
  return {
    risk_tolerance: "balanced", // "cautious" | "balanced" | "bold"
    min_savings_pct,            // only count drops at least this big (%)
    deadline_days,              // 1–90: how long the shopper can wait
    budget_usd: null,           // no budget: never "buy because it's under budget"
  };
}

/**
 * Thrown by getPrediction. `kind` tells the side panel which message to show:
 * "timeout" | "network" | "rejected" (422) | "http" (other non-2xx) |
 * "invalid_json" | "cancelled" (a newer request replaced this one).
 * `detail` is the backend's own error message, when it sent one.
 */
class PredictionError extends Error {
  constructor(kind, message, detail = null) {
    super(message);
    this.name = "PredictionError";
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * FastAPI errors look like { detail: "text" } for errors the app raises, or
 * { detail: [{ loc: ["body", "price"], msg: "..." }, ...] } when the request
 * fails schema validation. Turns either into one readable string.
 */
function readErrorDetail(body) {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const field = (d.loc ?? []).filter((part) => part !== "body").join(".");
        return field ? `${field}: ${d.msg}` : d.msg;
      })
      .join("; ");
  }
  return null;
}

/**
 * Gets a buy/wait prediction for a detected product from POST /predict.
 * Pass `options.signal` to cancel it (e.g. when the sliders move again);
 * a cancelled request rejects with kind "cancelled".
 */
async function getPrediction(product, preferences, options = {}) {
  // The backend ignores fields it doesn't know (title, url, site, ...).
  const body = { ...product, preferences };

  // One controller aborts the fetch for either reason: our timeout, or the
  // caller's signal. `timedOut` tells the two apart afterwards.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();

  const abortError = () =>
    timedOut
      ? new PredictionError("timeout", `No response from ${API_BASE_URL} after ${REQUEST_TIMEOUT_MS / 1000}s`)
      : new PredictionError("cancelled", "Replaced by a newer request");

  // The timer covers the whole exchange, including reading the body.
  try {
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw abortError();
      // fetch only rejects like this when there's no HTTP response at all,
      // e.g. the backend isn't running.
      throw new PredictionError("network", `Couldn't reach ${API_BASE_URL}: ${err.message}`);
    }

    if (!response.ok) {
      const detail = readErrorDetail(await response.json().catch(() => null));
      const kind = response.status === 422 ? "rejected" : "http";
      throw new PredictionError(kind, `POST /predict returned HTTP ${response.status}`, detail);
    }

    try {
      return await response.json();
    } catch (err) {
      if (err.name === "AbortError") throw abortError();
      throw new PredictionError("invalid_json", "POST /predict returned a response that isn't valid JSON");
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/** Reads a file from mock/ instead of calling the backend (dev tools). */
async function getMockPrediction(mockFile) {
  const response = await fetch(`../mock/${mockFile}`);
  if (!response.ok) throw new Error(`Loading mock/${mockFile} failed: HTTP ${response.status}`);
  return response.json();
}
