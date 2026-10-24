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
const DEFAULT_DEV_SETTINGS = { detection: "live", prediction: "predict.json" };

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

// chrome.storage keeps the choice between popup openings. When previewing
// popup.html as a plain page there's no chrome.storage, so use localStorage.
async function loadDevSettings() {
  if (!IS_DEV_INSTALL) return DEFAULT_DEV_SETTINGS;
  try {
    if (globalThis.chrome?.storage) {
      const stored = await chrome.storage.local.get(DEV_SETTINGS_KEY);
      return { ...DEFAULT_DEV_SETTINGS, ...stored[DEV_SETTINGS_KEY] };
    }
    return { ...DEFAULT_DEV_SETTINGS, ...JSON.parse(localStorage.getItem(DEV_SETTINGS_KEY)) };
  } catch {
    return DEFAULT_DEV_SETTINGS;
  }
}

async function saveDevSettings(settings) {
  try {
    if (globalThis.chrome?.storage) {
      await chrome.storage.local.set({ [DEV_SETTINGS_KEY]: settings });
    } else {
      localStorage.setItem(DEV_SETTINGS_KEY, JSON.stringify(settings));
    }
  } catch (err) {
    console.warn("[placeholder] couldn't save dev settings", err);
  }
}

async function setUpDevPanel() {
  if (!IS_DEV_INSTALL) return;
  const settings = await loadDevSettings();
  const detectionSelect = $("dev-detection");
  const predictionSelect = $("dev-prediction");
  detectionSelect.value = settings.detection;
  predictionSelect.value = settings.prediction;
  $("dev-panel").hidden = false;

  const onChange = async () => {
    await saveDevSettings({ detection: detectionSelect.value, prediction: predictionSelect.value });
    run();
  };
  detectionSelect.addEventListener("change", onChange);
  predictionSelect.addEventListener("change", onChange);
}

async function detectWithDevOverride(settings) {
  if (settings.detection === "live") return getDetection();
  return DEV_MOCK_DETECTIONS[settings.detection];
}

async function predictWithDevOverride(product, settings) {
  if (settings.prediction === "__loading") return new Promise(() => {});
  if (settings.prediction === "__error") throw new Error("Mock prediction failure");
  return getPrediction(product, { mockFile: settings.prediction });
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
  return prediction;
}

// Each run gets a number so that a slow, older run (e.g. after switching dev
// settings) can't overwrite the screen once a newer run has started.
let latestRun = 0;

async function run() {
  const runId = ++latestRun;
  const isCurrent = () => runId === latestRun;
  const settings = await loadDevSettings();

  renderProduct(null);
  renderLoading("Looking for a product on this page…");

  let detection;
  try {
    detection = await detectWithDevOverride(settings);
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

  renderLoading("Checking price history…");
  try {
    const prediction = checkPrediction(await predictWithDevOverride(detection.product, settings));
    if (!isCurrent()) return;
    console.log("[placeholder] prediction", prediction);
    renderRecommendation(prediction);
  } catch (err) {
    if (!isCurrent()) return;
    console.error("[placeholder] prediction failed", err);
    renderMessage("prediction_error");
  }
}

setUpDevPanel();
run();
