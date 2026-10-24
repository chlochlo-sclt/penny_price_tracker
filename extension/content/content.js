// Entry point for the content script. manifest.json loads utils.js and the
// extractors first, so by the time this runs they're on ProductDetect.
//
// Detection result shape (sent to the popup):
//   { status: "ok", product }
//   { status: "price_not_found", product, reason: "unavailable" | "no_price_element" }
//   { status: "not_product_page", product: null }
//   { status: "error", product: null, reason }
(() => {
  const ns = globalThis.ProductDetect;

  // To add a store: write content/extractors/<store>.js, add it (and the
  // store's URL pattern) to manifest.json, and register it here.
  const EXTRACTORS = [
    {
      name: "amazon",
      matches: (host) => host === "amazon.com" || host.endsWith(".amazon.com"),
      extract: ns.extractAmazon,
    },
  ];
  const FALLBACK_EXTRACTOR = { name: "generic", extract: ns.extractGeneric };

  function pickExtractor(hostname) {
    return EXTRACTORS.find((e) => e.matches(hostname)) ?? FALLBACK_EXTRACTOR;
  }

  // Runs fresh on every call rather than caching, because Amazon can swap the
  // product (e.g. picking a different color) without a full page load.
  function detectProduct() {
    const extractor = pickExtractor(location.hostname);
    try {
      return extractor.extract(document, location.href);
    } catch (err) {
      console.error(`[placeholder] ${extractor.name} extractor failed`, err);
      return { status: "error", product: null, reason: String(err?.message ?? err) };
    }
  }

  console.log("[placeholder] loaded", location.href);
  const initial = detectProduct();
  console.log(`[placeholder] detection: ${initial.status}`, initial);

  // The popup sends { type: "GET_PRODUCT" } when it opens. Replying with
  // sendResponse synchronously means we don't need to `return true`.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "GET_PRODUCT") return;
    const result = detectProduct();
    console.log(`[placeholder] detection for popup: ${result.status}`, result);
    sendResponse(result);
  });
})();
