# [placeholder]

A Chrome extension that tells shoppers on Amazon product pages whether to **Buy now** or **Wait**, based on a price-drop forecast from the Python backend in `backend/`.

## Loading the extension (development)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` folder (the one containing `manifest.json`).
4. Optional: pin it from the puzzle-piece Extensions menu so its icon stays in the toolbar.

### Reloading after changes

- **`manifest.json` or anything in `content/` changed:** click the reload (↻) icon on the extension's card in `chrome://extensions`, then **refresh any open Amazon tabs**. Already-open pages keep running the old content script until they're refreshed.
- **Popup files changed (`popup/*`):** just close and reopen the popup. The popup page is reloaded each time it opens.

If something fails to load, Chrome shows an **Errors** button on the extension's card with the details.

## How the extension is organized

```
extension/
  manifest.json            Extension config; lists the content scripts in load order
  content/                 Runs inside amazon.com pages
    utils.js               parsePrice, detectCurrency, cleanText
    extractors/generic.js  schema.org Product reader (JSON-LD, microdata, meta tags)
    extractors/amazon.js   Amazon extractor (ASIN, title, price strategies)
    content.js             Picks an extractor by hostname, answers the popup
  popup/                   The toolbar popup
    popup.html             Markup for every state (all styling in popup.css)
    api.js                 Data layer: getDetection(), getPrediction()
    render.js              Rendering layer: fills in the markup
    popup.js               Controller and dev tools
  mock/                    Fake /predict responses
```

Flow: when the popup opens, `popup.js` calls `getDetection()`. That sends `{ type: "GET_PRODUCT" }` to the active tab's content script, which runs the extractor and replies with `{ status, product }`. If the status is `"ok"`, `getPrediction(product)` loads a mock prediction and `render.js` draws the card.

To use the real backend, replace the body of `getPrediction()` in `popup/api.js` and add the backend URL to `host_permissions` in `manifest.json`.

To add a store (e.g. Target), write `content/extractors/target.js`, add it and the store's URL pattern to `manifest.json`, and register it in the `EXTRACTORS` list in `content/content.js`.

## Testing states with dev tools

Unpacked installs show a **Dev tools** section at the bottom of the popup with two dropdowns:

- **Product:** use the real current tab ("Live"), or fake a detection result: product found, price not found, item unavailable, not a product page, unsupported site, or detection error.
- **Prediction:** pick a file from `mock/` (`predict.json`, `predict_wait.json`, `predict_buy_now.json`, `predict_low_confidence.json`), a request that never finishes (loading state), or one that fails (error state).

The choice is saved in `chrome.storage.local` and kept between popup openings. Dev tools are hidden automatically for Chrome Web Store installs.

Debugging logs:

- **Content script:** open DevTools on the Amazon tab. The Console shows `[placeholder] detection: <status>` with the full result.
- **Popup:** right-click inside the popup and choose **Inspect**.

## Temporary product name

`[placeholder]` is a stand-in for the product name, which hasn't been chosen yet. Find-and-replace the exact string `[placeholder]` once it is. It appears in:

- `README.md` (title and this section)
- `extension/manifest.json` (`name` and `action.default_title`)
- `extension/content/content.js` (console log prefix)
- `extension/popup/popup.html` (`<title>` and `<h1>` heading)
- `extension/popup/popup.js` (console log prefix)
