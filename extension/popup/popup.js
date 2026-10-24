// Controller: runs each time the popup opens. It fetches data with api.js
// and hands it to render.js. Logs appear in the popup's own DevTools
// (right-click the popup → Inspect), not the page console.

console.log("[placeholder] popup opened");

// ---- Dev tools ------------------------------------------------------------
// A small panel at the bottom of the popup to fake each state. It only shows
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

// Kept between popup openings in chrome.storage.local (see shared/storage.js).
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
  $("dev-panel").hidden = false;

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
    console.log("[placeholder] prediction", request.preferences, prediction);
    renderRecommendation(prediction, request);
  } catch (err) {
    if (controller.signal.aborted || err?.kind === "cancelled") return;
    console.error("[placeholder] prediction failed", err, err?.detail ?? "");
    if (initial) renderPredictionError(err);
    else renderUpdateError(err);
  }
}

// Each run gets a number so that a slow, older run (e.g. after switching dev
// settings) can't overwrite the screen once a newer run has started.
let latestRun = 0;

async function run() {
  const runId = ++latestRun;
  const isCurrent = () => runId === latestRun;
  predictionController?.abort();
  currentProduct = null;
  $("watch-confirmation").hidden = true;
  currentSettings = await loadDevSettings();

  renderProduct(null);
  renderLoading("Looking for a product on this page…");

  let detection;
  try {
    detection = await detectWithDevOverride(currentSettings);
  } catch (err) {
    console.error("[placeholder] detection failed", err);
    detection = { status: "error", product: null, reason: String(err?.message ?? err) };
  }
  if (!isCurrent()) return;
  console.log("[placeholder] detection result", detection);

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
  setUpDevPanel();
  run();
}

start();
