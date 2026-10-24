// Runs on every https://www.amazon.com/* page (see manifest.json).
// Phase 1: just confirm the script is injected and detect product pages.

const url = window.location.href;
const isProductPage = url.includes("/dp/") || url.includes("/gp/product/");

console.log("[placeholder] loaded", url);
console.log("[placeholder] product page:", isProductPage);
