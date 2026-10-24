// Generic extractor: reads schema.org Product data that many stores publish
// for search engines. Used for any site without its own extractor, and as the
// last-resort price strategy inside site extractors (see amazon.js).
//
// Sources, in order of preference:
//   1. JSON-LD:   <script type="application/ld+json">{"@type": "Product", ...}</script>
//   2. Microdata: <div itemtype="https://schema.org/Product"> ... itemprop="price" ...
//   3. Meta tags: <meta property="og:title">, <meta property="product:price:amount">
(() => {
  const ns = (globalThis.ProductDetect ??= {});
  const { parsePrice, cleanText } = ns;

  function isProductNode(node) {
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => t === "Product" || t === "ProductGroup");
  }

  /** Yields every object in a JSON-LD document, including inside arrays and @graph. */
  function* walkJsonLd(value) {
    if (Array.isArray(value)) {
      for (const item of value) yield* walkJsonLd(item);
    } else if (value && typeof value === "object") {
      yield value;
      if (value["@graph"]) yield* walkJsonLd(value["@graph"]);
    }
  }

  /** Price and currency from a schema.org "offers" value (Offer, AggregateOffer or an array). */
  function readOffers(offers) {
    for (const offer of walkJsonLd(offers)) {
      const raw = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price;
      const price = parsePrice(raw);
      if (price != null) {
        const currency = offer.priceCurrency ?? offer.priceSpecification?.priceCurrency ?? null;
        return { price, currency };
      }
    }
    return { price: null, currency: null };
  }

  function readJsonLd(doc) {
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue; // Malformed JSON-LD is common; just skip that block.
      }
      for (const node of walkJsonLd(data)) {
        if (!isProductNode(node)) continue;
        const { price, currency } = readOffers(node.offers);
        return {
          method: "json_ld",
          title: typeof node.name === "string" ? node.name.trim() : null,
          product_id: node.sku ?? node.productID ?? node.gtin13 ?? node.gtin12 ?? node.mpn ?? null,
          price,
          currency,
        };
      }
    }
    return null;
  }

  function readMicrodata(doc) {
    const scope = doc.querySelector('[itemtype*="schema.org/Product"]');
    if (!scope) return null;
    const prop = (name) => {
      const el = scope.querySelector(`[itemprop="${name}"]`);
      return el ? (el.getAttribute("content") ?? cleanText(el)) : null;
    };
    return {
      method: "microdata",
      title: prop("name"),
      product_id: prop("sku") ?? prop("productID"),
      price: parsePrice(prop("price")),
      currency: prop("priceCurrency"),
    };
  }

  function readMetaTags(doc) {
    const meta = (key) =>
      doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content") ?? null;

    const amount = meta("product:price:amount") ?? meta("og:price:amount");
    // og:title exists on almost every page, so it only counts as product data
    // when the page also has a price tag or declares itself a product.
    if (amount == null && meta("og:type") !== "product") return null;
    return {
      method: "meta_tags",
      title: meta("og:title"),
      product_id: meta("product:retailer_item_id"),
      price: parsePrice(amount),
      currency: meta("product:price:currency") ?? meta("og:price:currency"),
    };
  }

  /**
   * Combines all structured-data sources. Returns null if the page has no
   * product data at all; otherwise { title, product_id, price, currency, method },
   * where price/method are null if no source had a price.
   */
  function readStructuredData(doc) {
    const sources = [readJsonLd(doc), readMicrodata(doc), readMetaTags(doc)].filter(Boolean);
    if (sources.length === 0) return null;
    const priced = sources.find((s) => s.price != null);
    return {
      title: sources.map((s) => s.title).find(Boolean) ?? null,
      product_id: sources.map((s) => s.product_id).find(Boolean) ?? null,
      price: priced?.price ?? null,
      currency: priced?.currency ?? null,
      method: priced?.method ?? null,
    };
  }

  function extractGeneric(doc, url) {
    const data = readStructuredData(doc);
    if (!data) return { status: "not_product_page", product: null };

    const product = {
      site: new URL(url).hostname.replace(/^www\./, ""),
      product_id: data.product_id,
      title: data.title ?? doc.title,
      price: data.price,
      currency: data.currency,
      url,
      extracted_at: new Date().toISOString(),
      method: data.method,
    };
    return data.price != null
      ? { status: "ok", product }
      : { status: "price_not_found", product, reason: "no_price_element" };
  }

  ns.readStructuredData = readStructuredData;
  ns.extractGeneric = extractGeneric;
})();
