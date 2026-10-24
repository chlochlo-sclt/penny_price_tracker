// Data layer: where the popup's data comes from. Nothing here touches the
// DOM; render.js does all the drawing and popup.js connects the two.

/**
 * Asks the active tab's content script what product it sees.
 * Always resolves with a detection result (see content/content.js), plus
 * status "no_content_script" when nothing on the tab answered.
 */
async function getDetection() {
  if (!globalThis.chrome?.tabs) {
    // Popup opened as a plain web page (e.g. for previewing), not as the extension.
    return { status: "no_content_script", product: null };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { status: "no_content_script", product: null };

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_PRODUCT" });
    return result ?? { status: "no_content_script", product: null };
  } catch {
    // Chrome rejects with "Receiving end does not exist" when no content
    // script is listening: a non-Amazon site, a chrome:// page, or an Amazon
    // tab that was opened before the extension was installed or reloaded.
    return { status: "no_content_script", product: null };
  }
}

/**
 * Gets a buy/wait prediction for a detected product.
 * This is the one function to replace when the backend is ready: keep the
 * same signature and return the same fields, e.g.
 *   const res = await fetch(`${API_BASE}/predict`, { method: "POST", ... body: JSON.stringify(product) });
 * `options.mockFile` picks which file in mock/ to return (dev tools use it).
 */
async function getPrediction(product, options = {}) {
  const mockFile = options.mockFile ?? "predict.json";
  const response = await fetch(`../mock/${mockFile}`);
  if (!response.ok) throw new Error(`Loading mock/${mockFile} failed: HTTP ${response.status}`);
  return response.json();
}
