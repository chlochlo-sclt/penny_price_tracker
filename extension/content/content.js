// Entry point for the content script. manifest.json loads utils.js and the
// extractors first, so by the time this runs they're on ProductDetect.
//
// Detection result shape (sent to the side panel):
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
      console.error(`penny ${extractor.name} extractor failed`, err);
      return { status: "error", product: null, reason: String(err?.message ?? err) };
    }
  }

  console.log("penny loaded", location.href);
  const initial = detectProduct();
  console.log(`penny detection: ${initial.status}`, initial);

  // "Buy now" in the side panel: bring the page's own buy button into view.
  function scrollToBuyButton() {
    const button = document.querySelector("#buy-now-button, #add-to-cart-button, #submit\\.add-to-cart");
    if (!button) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return "top";
    }
    button.scrollIntoView({ block: "center", behavior: "smooth" });
    button.focus({ preventScroll: true });
    return button.id || "buy button";
  }

  // Messages from the side panel. Replying with sendResponse synchronously
  // means we don't need to `return true`.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PRODUCT") {
      const result = detectProduct();
      console.log(`penny detection for side panel: ${result.status}`, result);
      sendResponse(result);
    } else if (message?.type === "SCROLL_TO_BUY") {
      sendResponse({ scrolledTo: scrollToBuyButton() });
    }
  });

  // Tell an open side panel that this page is ready, or that Amazon changed
  // the URL without a full reload (e.g. picking another color or size). The
  // panel ignores it unless this is its window's active tab. When no panel
  // is open there's no receiver, so the error is expected and ignored.
  function announcePageChanged() {
    chrome.runtime.sendMessage({ type: "PAGE_CHANGED", url: location.href }).catch(() => {});
    // The background worker uses this price to update a watch on this
    // product for free (no backend check); it ignores products not watched.
    const result = detectProduct();
    if (result.status === "ok") {
      chrome.runtime.sendMessage({ type: "PRODUCT_SEEN", product: result.product }).catch(() => {});
    }
  }
  announcePageChanged();
  globalThis.navigation?.addEventListener("navigatesuccess", announcePageChanged);
})();
