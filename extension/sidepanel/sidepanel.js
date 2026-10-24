// Controller for the side panel. It fetches data with api.js and hands it to
// render.js, and re-runs whenever the active tab changes, since the panel
// stays open across tabs. Logs appear in the panel's own DevTools
// (right-click inside the panel → Inspect), not the page console.

console.log("penny side panel opened");

// ---- Dev tools ------------------------------------------------------------
// A small section at the bottom of the panel to fake each state. It only shows
// for unpacked installs: Chrome Web Store installs have an update_url in
// their manifest, unpacked ones don't. Outside the extension (plain page
// preview) it always shows.

const IS_DEV_INSTALL = !globalThis.chrome?.runtime?.getManifest?.().update_url;
const DEV_SETTINGS_KEY = "devSettings";
// source: "backend" calls POST /predict; "mock" reads `prediction` from mock/.
const DEFAULT_DEV_SETTINGS = { detection: "live", source: "backend", prediction: "predict.json" };

const DEV_MOCK_PRODUCT = {
  site: "amazon",
  product_id: "B0DEVMOCK1",
  title: "Example Wireless Noise-Cancelling Headphones, 40-Hour Battery",
  price: 119.99,
  currency: "USD",
  url: "https://www.amazon.com/dp/B0DEVMOCK1",
  extracted_at: new Date().toISOString(),
  method: "mock",
};

const DEV_MOCK_DETECTIONS = {
  ok: { status: "ok", product: DEV_MOCK_PRODUCT },
  price_not_found: {
    status: "price_not_found",
    product: { ...DEV_MOCK_PRODUCT, price: null, currency: null, method: null },
    reason: "no_price_element",
  },
  unavailable: {
    status: "price_not_found",
    product: { ...DEV_MOCK_PRODUCT, price: null, currency: null, method: null },
    reason: "unavailable",
  },
  not_product_page: { status: "not_product_page", product: null },
  no_content_script: { status: "no_content_script", product: null },
  error: { status: "error", product: null, reason: "Mock detection error" },
};

// Kept between panel openings in chrome.storage.local (see shared/storage.js).
async function loadDevSettings() {
  if (!IS_DEV_INSTALL) return DEFAULT_DEV_SETTINGS;
  return { ...DEFAULT_DEV_SETTINGS, ...(await storageGet("local", DEV_SETTINGS_KEY, {})) };
}

async function setUpDevPanel() {
  if (!IS_DEV_INSTALL) return;
  const settings = await loadDevSettings();
  const detectionSelect = $("dev-detection");
  const sourceSelect = $("dev-source");
  const predictionSelect = $("dev-prediction");
  detectionSelect.value = settings.detection;
  sourceSelect.value = settings.source;
  predictionSelect.value = settings.prediction;
  // The mock file only matters in mock mode.
  const syncMockFileState = () => { predictionSelect.disabled = sourceSelect.value !== "mock"; };
  syncMockFileState();
  await setUpDemoMode();

  const onChange = async () => {
    syncMockFileState();
    await storageSet("local", DEV_SETTINGS_KEY, {
      detection: detectionSelect.value,
      source: sourceSelect.value,
      prediction: predictionSelect.value,
    });
    run();
  };
  for (const select of [detectionSelect, sourceSelect, predictionSelect]) {
    select.addEventListener("change", onChange);
  }
}

// ---- Demo mode ------------------------------------------------------------
// Hides the dev tools completely (for judging) and remembers that in
// chrome.storage.local. Mock settings chosen before turning it on stay in
// effect. To bring the dev tools back: Alt+Shift+D, or click the logo 5 times.

const DEMO_MODE_KEY = "demoMode";
const LOGO_CLICKS_TO_EXIT = 5;

async function setDemoMode(on) {
  $("dev-panel").hidden = on;
  $("dev-demo-mode").checked = on;
  await storageSet("local", DEMO_MODE_KEY, on);
}

async function setUpDemoMode() {
  await setDemoMode(await storageGet("local", DEMO_MODE_KEY, false));
  $("dev-demo-mode").addEventListener("change", (event) => setDemoMode(event.target.checked));

  document.addEventListener("keydown", (event) => {
    // event.code, not event.key: Option+Shift+D types "Î" on a Mac keyboard.
    if (event.altKey && event.shiftKey && event.code === "KeyD") setDemoMode(!$("dev-panel").hidden);
  });

  let clicks = 0;
  let resetTimer = null;
  $("panel-brand").addEventListener("click", () => {
    clicks += 1;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { clicks = 0; }, 1500);
    if (clicks >= LOGO_CLICKS_TO_EXIT) {
      clicks = 0;
      setDemoMode(false);
    }
  });
}

async function detectWithDevOverride(settings) {
  if (settings.detection === "live") return getDetection();
  return DEV_MOCK_DETECTIONS[settings.detection];
}

async function predictWithDevOverride(product, preferences, settings, signal) {
  if (settings.source !== "mock") return getPrediction(product, preferences, { signal });
  if (settings.prediction === "__loading") return new Promise(() => {});
  if (settings.prediction === "__error") throw new Error("Mock prediction failure");
  return getMockPrediction(settings.prediction);
}

// ---- Main flow ------------------------------------------------------------

/** Throws if the response doesn't have the fields the card needs. */
function checkPrediction(prediction) {
  if (!["buy_now", "wait"].includes(prediction?.recommendation)) {
    throw new Error(`Unexpected recommendation: ${prediction?.recommendation}`);
  }
  if (!["high", "medium", "low"].includes(prediction.confidence)) {
    throw new Error(`Unexpected confidence: ${prediction.confidence}`);
  }
  if (!["real", "mixed", "simulated", "mock"].includes(prediction.data_source)) {
    throw new Error(`Unexpected data_source: ${prediction.data_source}`);
  }
  return prediction;
}

// The product the card is about, the dev settings for this run, and the
// prediction request in flight (so a newer one can cancel it).
let currentProduct = null;
let currentSettings = DEFAULT_DEV_SETTINGS;
let predictionController = null;

/**
 * Requests a prediction for currentProduct with the given slider values.
 * Cancels any request still in flight, so only the latest result renders.
 * The first request of a run shows the full loading view; later ones (from
 * the sliders) keep the card visible and show a small "Updating…" state.
 */
async function requestPrediction(sliderValues, { initial }) {
  predictionController?.abort();
  const controller = (predictionController = new AbortController());
  const request = {
    preferences: getPreferences(sliderValues),
    price: currentProduct.price,
    currency: currentProduct.currency ?? "USD",
  };

  if (initial) renderLoading("Checking price history…");
  else renderUpdating(true);

  try {
    const raw = await predictWithDevOverride(currentProduct, request.preferences, currentSettings, controller.signal);
    if (controller.signal.aborted) return;
    const prediction = checkPrediction(raw);
    console.log("penny prediction", request.preferences, prediction);
    renderRecommendation(prediction, request);
  } catch (err) {
    if (controller.signal.aborted || err?.kind === "cancelled") return;
    console.error("penny prediction failed", err, err?.detail ?? "");
    if (initial) renderPredictionError(err);
    else renderUpdateError(err);
  }
}

// Each run gets a number so that a slow, older run (e.g. for the tab the user
// just left) can't overwrite the screen once a newer run has started. Its
// prediction request is also cancelled (see requestPrediction).
let latestRun = 0;

const isSameProduct = (product, detection) =>
  product != null &&
  detection.status === "ok" &&
  detection.product.product_id === product.product_id &&
  detection.product.price === product.price;

/** Forget the current product and cancel its forecast. */
function resetProduct() {
  predictionController?.abort();
  currentProduct = null;
  $("watch-confirmation").hidden = true;
}

/**
 * Detects the product on the active tab and shows its forecast.
 * A "soft" run (the page finished loading, or announced itself) doesn't
 * blank the screen first, and keeps the current card untouched if the page
 * still shows the same product at the same price.
 */
async function run({ soft = false } = {}) {
  const runId = ++latestRun;
  const isCurrent = () => runId === latestRun;
  const previous = currentProduct;
  if (!soft) {
    resetProduct();
    renderProduct(null);
    renderLoading("Looking for a product on this page…");
  }
  currentSettings = await loadDevSettings();

  let detection;
  try {
    detection = await detectWithDevOverride(currentSettings);
  } catch (err) {
    console.error("penny detection failed", err);
    detection = { status: "error", product: null, reason: String(err?.message ?? err) };
  }
  if (!isCurrent()) return;
  console.log("penny detection result", detection);
  if (soft && isSameProduct(previous, detection)) return; // nothing changed
  resetProduct();

  // price_not_found still has a product, so its title shows above the message.
  renderProduct(detection.product);
  if (detection.status !== "ok") {
    renderDetectionProblem(detection);
    return;
  }

  currentProduct = detection.product;
  PreferenceSliders.setPrice(currentProduct.price, currentProduct.currency ?? "USD");
  WatchlistUI.refresh();
  await requestPrediction(PreferenceSliders.getValues(), { initial: true });
}

// ---- Following the active tab --------------------------------------------
// The panel belongs to one browser window and shows that window's active tab.
// Re-run when the user switches tabs, when the tab starts or finishes
// loading, or when the content script reports an in-page URL change.
// Bursts of events (loading → complete → PAGE_CHANGED) are coalesced into
// one run; if any event in the burst needed a hard refresh, it's hard.

const REFRESH_DELAY_MS = 150;
let refreshTimer = null;
let pendingHardRefresh = false;

function scheduleRefresh(reason, { soft = false } = {}) {
  pendingHardRefresh ||= !soft;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const hard = pendingHardRefresh;
    pendingHardRefresh = false;
    console.log(`penny refreshing (${hard ? "hard" : "soft"}): ${reason}`);
    run({ soft: !hard });
  }, REFRESH_DELAY_MS);
}

async function followActiveTab() {
  if (!globalThis.chrome?.tabs?.onActivated) return; // plain-page preview
  const panelWindowId = (await chrome.windows.getCurrent()).id;

  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === panelWindowId) scheduleRefresh("switched tabs");
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.windowId !== panelWindowId || !tab.active) return;
    // "loading" = a navigation started, so the old product is gone.
    // "complete" often comes long after the content script answered.
    if (changeInfo.status === "loading") scheduleRefresh("tab loading");
    if (changeInfo.status === "complete") scheduleRefresh("tab complete", { soft: true });
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "PAGE_CHANGED") return;
    if (sender.tab?.active && sender.tab.windowId === panelWindowId) {
      scheduleRefresh("content script reported a page change", { soft: true });
    }
  });
}

async function start() {
  // Slider moves (already debounced by sliders.js) re-request the forecast.
  await PreferenceSliders.init((values) => {
    WatchlistUI.refresh();
    if (currentProduct) requestPrediction(values, { initial: false });
  });
  await WatchlistUI.init({
    getProduct: () => currentProduct,
    getGoal: () => PreferenceSliders.getValues(),
  });
  $("message-retry").addEventListener("click", () => run());
  $("why-toggle").addEventListener("click", () => {
    const toggle = $("why-toggle");
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    $("why-panel").hidden = !open;
  });
  setUpDevPanel();
  await followActiveTab();
  run();
}

start();
