// Amazon extractor. Amazon's markup changes often and varies by product type,
// so the price is found by trying several strategies in order (most reliable
// first). Whichever strategy succeeds is recorded in product.method, so when
// a page breaks you can see in the console which strategy it fell back to.
(() => {
  const ns = (globalThis.ProductDetect ??= {});
  const { parsePrice, detectCurrency, cleanText } = ns;

  // Matches /dp/ASIN, /gp/product/ASIN and two older URL forms. ASINs are 10
  // letters/digits, e.g. B0CHX1W1XY.
  const ASIN_IN_URL = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?=[/?#]|$)/i;
  const ASIN_FORMAT = /^[A-Z0-9]{10}$/;

  // Prices inside these elements are not what you'd pay: struck-through list
  // prices ("List: $49.99"), "Was" prices, and per-unit prices ("$0.25/oz").
  const NOT_THE_PRICE = ".a-text-price, [data-a-strike='true'], .basisPrice, .pricePerUnit, #pricePerUnit";

  // Containers that hold the main price near the "Add to Cart" area.
  const PRICE_CONTAINERS = [
    "#corePriceDisplay_desktop_feature_div",
    "#corePrice_feature_div",
    "#corePrice_desktop",
    "#apex_desktop",
  ];

  /**
   * Builds a strategy that tries each selector in turn and returns the first
   * element whose text parses as a price, skipping list/was/unit prices.
   * Using the first match inside a specific container is how we pick the
   * right price when a page shows several (e.g. "Other sellers" or bundles).
   */
  function fromSelectors(selectors) {
    return (doc) => {
      for (const selector of selectors) {
        for (const el of doc.querySelectorAll(selector)) {
          if (el.closest(NOT_THE_PRICE)) continue;
          const text = cleanText(el);
          const price = parsePrice(text);
          if (price != null) return { price, currency: detectCurrency(text) };
        }
      }
      return null;
    };
  }

  // Some layouts leave .a-offscreen empty and only fill the visible pieces:
  // <span class="a-price-symbol">$</span><span class="a-price-whole">1,299.</span><span class="a-price-fraction">99</span>
  function fromWholeAndFraction(doc) {
    for (const container of PRICE_CONTAINERS) {
      for (const el of doc.querySelectorAll(`${container} .a-price`)) {
        if (el.closest(NOT_THE_PRICE)) continue;
        const whole = cleanText(el.querySelector(".a-price-whole")).replace(/[^\d,]/g, "");
        if (!whole) continue;
        const fraction = cleanText(el.querySelector(".a-price-fraction")).replace(/\D/g, "") || "00";
        const price = parsePrice(`${whole}.${fraction}`);
        if (price != null) {
          return { price, currency: detectCurrency(cleanText(el.querySelector(".a-price-symbol"))) };
        }
      }
    }
    return null;
  }

  // Hidden form inputs that Amazon uses for its own cart/variant widgets.
  // They hold a plain number like "1299.99", which avoids text parsing issues,
  // but they can lag behind the visible price after switching variants, so
  // they're tried after the visible-price strategies.
  function fromHiddenInputs(doc) {
    const pairs = [
      ["#twister-plus-price-data-price", "#twister-plus-price-data-price-unit"],
      ["#attach-base-product-price", "#attach-base-product-currency-symbol"],
    ];
    for (const [priceSel, currencySel] of pairs) {
      const price = parsePrice(doc.querySelector(priceSel)?.value);
      if (price != null) {
        return { price, currency: detectCurrency(doc.querySelector(currencySel)?.value) };
      }
    }
    return null;
  }

  function fromStructuredData(doc) {
    const data = ns.readStructuredData(doc);
    return data?.price != null ? { price: data.price, currency: data.currency } : null;
  }

  const PRICE_STRATEGIES = [
    {
      // Current (2024+) layout: the price you pay is marked .priceToPay.
      method: "core_price_to_pay",
      find: fromSelectors([
        "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
        "#corePrice_feature_div .priceToPay .a-offscreen",
        "#apex_desktop .priceToPay .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .priceToPay .aok-offscreen",
      ]),
    },
    {
      // Same containers without .priceToPay; first non-struck price wins.
      method: "core_price",
      find: fromSelectors(PRICE_CONTAINERS.map((c) => `${c} .a-price .a-offscreen`)),
    },
    {
      method: "buybox_price",
      find: fromSelectors([
        "#price_inside_buybox",
        "#newBuyBoxPrice",
        "#tp_price_block_total_price_ww .a-offscreen",
        "#buybox .a-price .a-offscreen",
      ]),
    },
    {
      // Older layout, still seen on some deal and media pages.
      method: "legacy_priceblock",
      find: fromSelectors([
        "#priceblock_dealprice",
        "#priceblock_saleprice",
        "#priceblock_ourprice",
        "#kindle-price",
      ]),
    },
    { method: "price_whole_fraction", find: fromWholeAndFraction },
    { method: "hidden_price_input", find: fromHiddenInputs },
    { method: "structured_data", find: fromStructuredData },
  ];

  function asinFromUrl(url) {
    const match = new URL(url).pathname.match(ASIN_IN_URL);
    return match ? match[1].toUpperCase() : null;
  }

  // Only trusted when #productTitle exists: search and category pages also
  // contain ASINs (one per result), and those aren't product pages.
  function asinFromPage(doc) {
    if (!doc.querySelector("#productTitle")) return null;
    const value = doc.querySelector("#ASIN, input[name='ASIN']")?.value?.trim().toUpperCase();
    return value && ASIN_FORMAT.test(value) ? value : null;
  }

  function findTitle(doc) {
    const fromPage = cleanText(doc.querySelector("#productTitle")) || cleanText(doc.querySelector("#title"));
    if (fromPage) return fromPage;
    // document.title looks like "Amazon.com: Product Name : Category" or
    // "Amazon.com | Product Name | Category".
    return doc.title.replace(/^Amazon\.com\s*[:|]\s*/i, "").split(/\s+[:|]\s+/)[0].trim() || null;
  }

  // "Currently unavailable" is Amazon's wording when nobody is selling the
  // item, so there is no real price even if stale numbers linger in the page.
  function isUnavailable(doc) {
    if (doc.querySelector("#outOfStock")) return true;
    return /currently unavailable/i.test(cleanText(doc.querySelector("#availability")));
  }

  function extractAmazon(doc, url) {
    const asin = asinFromUrl(url) ?? asinFromPage(doc);
    if (!asin) return { status: "not_product_page", product: null };

    const product = {
      site: "amazon",
      product_id: asin,
      title: findTitle(doc),
      price: null,
      currency: null,
      // Canonical URL without tracking parameters, so the same product always
      // produces the same URL.
      url: `${new URL(url).origin}/dp/${asin}`,
      extracted_at: new Date().toISOString(),
      method: null,
    };

    if (isUnavailable(doc)) {
      return { status: "price_not_found", product, reason: "unavailable" };
    }

    for (const strategy of PRICE_STRATEGIES) {
      const hit = strategy.find(doc);
      if (hit) {
        product.price = hit.price;
        product.currency = hit.currency ?? "USD"; // amazon.com prices are in USD
        product.method = strategy.method;
        return { status: "ok", product };
      }
    }
    return { status: "price_not_found", product, reason: "no_price_element" };
  }

  ns.extractAmazon = extractAmazon;
})();
