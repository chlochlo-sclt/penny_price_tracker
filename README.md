# [placeholder]

A Chrome extension that tells shoppers on Amazon product pages whether to **Buy now** or **Wait**, based on a price-drop forecast from the Python backend in `app/`.

## Loading the extension (development)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` folder (the one containing `manifest.json`).
4. Optional: pin it from the puzzle-piece Extensions menu so its icon stays in the toolbar.

### Reloading after changes

- **`manifest.json` or anything in `content/` changed:** click the reload (↻) icon on the extension's card in `chrome://extensions`, then **refresh any open Amazon tabs**. Already-open pages keep running the old content script until they're refreshed.
- **Popup files changed (`popup/*`):** just close and reopen the popup. The popup page is reloaded each time it opens.
- **`background/` or `shared/` changed:** click reload (↻) on the extension's card. The background worker only picks up changes after a reload.

If something fails to load, Chrome shows an **Errors** button on the extension's card with the details.

## How the extension is organized

```
extension/
  manifest.json            Extension config; lists the content scripts in load order
  shared/                  Loaded by both the popup and the background worker
    config.js              API_BASE_URL and the request timeout
    storage.js             chrome.storage wrapper (localStorage fallback for previews)
    dates.js               Local-date helpers, next Black Friday
    watchlist.js           Watch records: create, save, update, remove
  background/
    background.js          Service worker: alarm, price checks, notifications
  icons/                   Toolbar and notification icons (placeholder art)
  content/                 Runs inside amazon.com pages
    utils.js               parsePrice, detectCurrency, cleanText
    extractors/generic.js  schema.org Product reader (JSON-LD, microdata, meta tags)
    extractors/amazon.js   Amazon extractor (ASIN, title, price strategies)
    content.js             Picks an extractor by hostname, answers the popup
  popup/                   The toolbar popup
    popup.html             Markup for every state (all styling in popup.css)
    api.js                 Data layer: getDetection(), getPreferences(), getPrediction()
    render.js              Rendering layer: fills in the markup
    sliders.js             Savings and deadline sliders, saved in chrome.storage.sync
    watchlist-ui.js        Buy now / Wait & watch buttons, Watching list, simulate buttons
    popup.js               Controller and dev tools
  mock/                    Fake /predict responses
```

Flow: when the popup opens, `popup.js` calls `getDetection()`. That sends `{ type: "GET_PRODUCT" }` to the active tab's content script, which runs the extractor and replies with `{ status, product }`. If the status is `"ok"`, `getPrediction(product, preferences)` POSTs the product and the slider values to the backend, and `render.js` draws the card. When a slider moves, `sliders.js` waits 300 ms, then `popup.js` sends a new request and cancels any request still in flight, so only the latest result is shown.

"Wait & watch" saves a watch in `chrome.storage.local`. Every 30 minutes, `background.js` checks each watch's price and shows a notification when the target price is hit, or when the deadline is 3 days away and the price hasn't dropped.

To add a store (e.g. Target), write `content/extractors/target.js`, add it and the store's URL pattern to `manifest.json`, and register it in the `EXTRACTORS` list in `content/content.js`.

## Connecting to the backend

The popup calls `POST http://127.0.0.1:8000/predict` with `{ ...product, preferences }`. The request comes from the popup, not the content script, and the request and response shapes are defined in `app/schemas.py`.

- **Backend URL:** `API_BASE_URL` in `shared/config.js`. If you change it, also update `host_permissions` in `manifest.json`, or Chrome will block the request.
- **Preferences:** `getPreferences()` in `popup/api.js` builds them from the two sliders: `min_savings_pct` (0–30) and `deadline_days` (1–90). `risk_tolerance` is always `"balanced"` and `budget_usd` is always `null`. If storage is empty or broken, the sliders default to 5% and 14 days.
- **Current price for watches:** `getCurrentPrice(watch)` in `background/background.js` calls `GET /price/{product_id}` and expects `{ "price": 123.45 }`. That endpoint doesn't exist yet; until it does, checks are skipped quietly (and so are price-drop notifications from real checks).
- **Errors:** requests time out after 10 seconds. The popup shows separate messages for a backend that isn't running, a timeout, a 422 (with the backend's own message, e.g. "Only USD prices are supported right now."), and any other failure.

Start the backend from the repo root before opening the popup:

```bash
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Each `/predict` call for a new product adds labeled simulated history to `data/processed/price_history.json`, so expect that file to change while testing.

## Testing states with dev tools

Unpacked installs show a **Dev tools** section at the bottom of the popup with three dropdowns:

- **Product:** use the real current tab ("Live"), or fake a detection result: product found, price not found, item unavailable, not a product page, unsupported site, or detection error.
- **Data source:** **Backend** (default) calls `/predict`; **Mock** skips the backend and uses the mock file below.
- **Mock file:** pick a file from `mock/` (`predict.json`, `predict_wait.json`, `predict_buy_now.json`, `predict_low_confidence.json`), a request that never finishes (loading state), or one that fails (error state).

Below the dropdowns, **Watched item** with **Simulate price drop** and **Simulate deadline approaching** runs the background worker's real notification code with a faked price or date. Simulating resets the item's "already notified" flags, so you can repeat the demo.

The dropdown choices are saved in `chrome.storage.local` and kept between popup openings. Dev tools are hidden automatically for Chrome Web Store installs.

Debugging logs:

- **Content script:** open DevTools on the Amazon tab. The Console shows `[placeholder] detection: <status>` with the full result.
- **Popup:** right-click inside the popup and choose **Inspect**.
- **Background worker:** on `chrome://extensions`, click **service worker** on the extension's card.

### Notifications on macOS

Chrome needs permission to show notifications: **System Settings → Notifications → Google Chrome → Allow notifications**. In **Banners** style, the notification buttons ("Buy now", "Keep waiting") are hidden under **Options**; choose **Alerts** to show them directly. Focus modes and Do Not Disturb hide notifications too.

## Temporary product name

`[placeholder]` is a stand-in for the product name, which hasn't been chosen yet. Find-and-replace the exact string `[placeholder]` once it is. It appears in:

- `README.md` (title and this section)
- `extension/manifest.json` (`name` and `action.default_title`)
- `extension/content/content.js` (console log prefix)
- `extension/popup/popup.html` (`<title>` and `<h1>` heading)
- `extension/popup/popup.js` (console log prefix)
- `extension/shared/storage.js` (console warning prefix)
- `extension/background/background.js` (console error prefix)
