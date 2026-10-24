// Shared helpers for the extractors.
//
// All content scripts listed together in manifest.json run in one shared
// global scope (the extension's isolated world, separate from the page's own
// JavaScript). To avoid name clashes between files, each file wraps its code
// in an IIFE and exposes only what others need on the ProductDetect namespace.
(() => {
  const ns = (globalThis.ProductDetect ??= {});

  /**
   * Turns price text such as "$1,299.99", "1.299,99 €" or "USD 24" into a
   * number. Returns null when there is no positive number in the text.
   * For a range like "$10.99 - $24.99" it returns the first number.
   */
  function parsePrice(raw) {
    if (raw == null) return null;
    const match = String(raw).match(/\d[\d.,]*/);
    if (!match) return null;

    let num = match[0].replace(/[.,]+$/, "");
    const lastComma = num.lastIndexOf(",");
    const lastDot = num.lastIndexOf(".");

    if (lastComma !== -1 && lastDot !== -1) {
      // Both separators present: whichever comes last is the decimal point.
      num = lastComma > lastDot
        ? num.replace(/\./g, "").replace(",", ".")
        : num.replace(/,/g, "");
    } else if (lastComma !== -1) {
      // Only commas: "1,299" and "1,299,000" are thousands; "12,99" is a decimal.
      const commaCount = num.split(",").length - 1;
      const digitsAfter = num.length - lastComma - 1;
      num = commaCount > 1 || digitsAfter === 3
        ? num.replace(/,/g, "")
        : num.replace(",", ".");
    } else if (num.split(".").length - 1 > 1) {
      // Several dots ("1.299.000") can only be thousands separators.
      num = num.replace(/\./g, "");
    }

    const value = Number(num);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // Checked in order, so the more specific dollar signs come before plain "$".
  const CURRENCY_SYMBOLS = [
    [/CA\$|C\$/, "CAD"],
    [/AU\$|A\$/, "AUD"],
    [/\$/, "USD"],
    [/£/, "GBP"],
    [/€/, "EUR"],
    [/¥|￥/, "JPY"],
    [/₹/, "INR"],
  ];

  /** Guesses an ISO currency code from price text; returns null if it can't tell. */
  function detectCurrency(raw) {
    if (!raw) return null;
    const text = String(raw);
    const code = text.match(/\b([A-Z]{3})\b/);
    if (code) return code[1];
    const symbol = CURRENCY_SYMBOLS.find(([pattern]) => pattern.test(text));
    return symbol ? symbol[1] : null;
  }

  /** Text content of an element with whitespace collapsed, or "" if missing. */
  function cleanText(el) {
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  ns.parsePrice = parsePrice;
  ns.detectCurrency = detectCurrency;
  ns.cleanText = cleanText;
})();
