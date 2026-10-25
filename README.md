# penny

penny is a Chrome extension (always written lowercase) that tells shoppers on Amazon product pages whether to **buy now** or **wait**, based on a price-drop forecast from the Python backend in `app/`.

## Running it

### 1. Start the backend

From the repo root:

```bash
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The extension talks to `http://127.0.0.1:8000` (`API_BASE_URL` in `extension/shared/config.js`). If you change it, also update `host_permissions` in `extension/manifest.json`, or Chrome will block the requests. Apify keys live only in the backend's `.env`; nothing secret is in `extension/`.

### 2. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right corner).
3. Click **Load unpacked** and select the `extension/` folder (the one containing `manifest.json`).
4. Pin penny from the puzzle-piece Extensions menu, then click its icon to open the side panel. It stays open as you switch tabs and follows the active tab.

After changing files:

- **`manifest.json`, `content/`, `background/` or `shared/`:** click reload (↻) on penny's card, then refresh any open Amazon tabs.
- **`sidepanel/`:** close and reopen the side panel.

If something fails to load, Chrome shows an **Errors** button on the extension's card.

### 3. Demo products

| Product | ASIN | Page |
|---|---|---|
| CeraVe | `B00TTD9BRC` | https://www.amazon.com/dp/B00TTD9BRC |
| Crest | `B00AHAWWO0` | https://www.amazon.com/dp/B00AHAWWO0 |
| AirPods Pro 2 | `B0BDHWDR12` | https://www.amazon.com/dp/B0BDHWDR12 |

To show a **wait** verdict on demand, use the confidence slider. AirPods with a 3% savings goal and a 35-day deadline is "buy now" at 65% (a 59% chance) and "wait" at 50%.

### 4. Demo flow

1. Open a demo product. The panel shows the verdict, the predicted lowest price and the chance line.
2. Drag the sliders; the forecast updates after a short pause.
3. On a wait verdict, click **wait & watch**, then **add to google calendar**.
4. Press **Alt+Shift+P** (Option+Shift+P on a Mac) to fire the price-drop notification (see below), and click **Buy now** in it.

### Demo shortcut: a pretend price drop

**Alt+Shift+P** (Option+Shift+P on a Mac) is a hidden dev-only shortcut, the `simulate-price-drop` command in `manifest.json`. It takes the most recently created active watch and runs the same evaluate-and-notify code as a real check, with a pretend price 1¢ below its target. You get the real notification, whose **Buy now** opens the product and **Keep waiting** dismisses it.

- It's a simulation: the pretend price is never saved, and the worker logs it as `[simulation]`. Like a real hit, it marks the watch done, so the next press uses the next-newest active watch, or logs that there's none.
- It only works for unpacked (developer) installs. In a Web Store install it does nothing and logs why.
- To change the key, open `chrome://extensions/shortcuts` and set one for "dev: simulate a price drop…". To change the default, edit `suggested_key` in `manifest.json`; Chrome only applies a new default when the extension is freshly installed.

### Notifications on macOS

Chrome needs permission: **System Settings → Notifications → Google Chrome → Allow notifications**. In **Banners** style, the buttons ("Buy now", "Keep waiting") are under **Options**; choose **Alerts** to show them directly. Focus modes and Do Not Disturb hide notifications.

## Watching prices (and saving Apify credits)

"wait & watch" saves a watch in `chrome.storage.local`: the target price (today's price minus the savings %), the deadline, and the price when you started.

The background worker (`extension/background/background.js`) checks watches with the backend's `GET /watch-check/{asin}?target_price=17.50&deadline=2026-11-20`. That call returns `{ asin, price, currency, title, as_of, cached, target_price, target_hit, days_left, buy_reminder }`; a 503 means price checks are off or Apify failed.

An uncached check scrapes Amazon through Apify, so checks are rationed. The numbers are in `extension/shared/config.js`:

- **Interval:** one alarm, every 12 hours (`WATCH_CHECK_INTERVAL_HOURS`). Never a tight loop.
- **Per watch:** skipped if it was checked in the last 12 hours. Attempts count, so failures aren't retried early. A never-checked watch counts from when it was created.
- **Install, reload and browser startup:** no immediate checks, except for watches already 12+ hours overdue. Reloading during development never triggers fresh checks.
- **Stopping:** a watch stops being checked once its target is hit or its deadline has passed.
- **Daily cap:** at most 5 backend checks a day across all watches (`WATCH_CHECKS_PER_DAY`), counted in storage. Reaching it is logged in the worker's console.
- **Failures:** on a 503 or a network error, the error is recorded on the watch and the next scheduled check is the next attempt. No retries.
- **The side panel never calls `/watch-check`.** Only the alarm and the dev-tools **check price now** button do.
- **Free updates:** visiting a watched product's page updates it from the price the content script already read, checks the target locally with no backend call, and counts as that watch's check.

When the target is hit (from `/watch-check` or a page visit), penny shows one notification: "it hit your target price, buy now", with **Buy now** (opens the product page) and **Keep waiting**. It fires once per watch, and the watch is then done. There's no deadline notification. The backend's `buy_reminder` is ignored, because the Google Calendar event covers the deadline.

**add to google calendar** (in the watch confirmation) opens Google Calendar's public event-template page in a new tab, with no sign-in or API. It's an all-day event 3 days before the deadline, or today if the deadline is closer than that.

- **Title:** "buy by nov 13: [short product title] — check penny".
- **Description:** the target ("drops 10% to $107.99 or less"), the actual deadline, the product URL and the price when you started watching.

Every value comes from the saved watch and is URL-encoded.

## Dev tools

Unpacked installs show **dev tools** at the bottom of the panel, collapsed. They're hidden automatically in Web Store installs.

- **Product:** use the current tab ("live"), or fake a detection result.
- **Data source:** **backend** (default) calls `/predict`; **mock** uses a file from `extension/mock/` instead. Every mock matches `PredictResponse` in `app/schemas.py`, and there are also "never finishes" and "request fails" options.
- **Watched item + check price now:** exactly one `/watch-check` for the selected watch. It shows the price, whether it was cached (free) or fresh (used credits), and whether the target was hit. It's disabled for 10 minutes after use, and shows today's count against the daily cap.
- **Demo mode:** hides the dev tools completely and is remembered. Bring them back with Alt+Shift+D (Option+Shift+D) in the panel, or by clicking the coin 5 times.

Debugging logs:

- **Content script:** the Amazon tab's DevTools console.
- **Side panel:** right-click inside the panel → **Inspect**.
- **Background worker:** **service worker** on penny's card in `chrome://extensions`.

## How the extension is organized

```
extension/
  manifest.json            Extension config: content scripts, side panel, worker, dev shortcut
  shared/                  Loaded by both the side panel and the background worker
    config.js              API_BASE_URL, timeouts, the price-check limits
    storage.js             chrome.storage wrapper (localStorage fallback for previews)
    dates.js               Local-date helpers, upcoming holidays
    watchlist.js           Watch records, active/due rules, the daily check counter
  background/
    background.js          Alarm, /watch-check, page price updates, notification, dev shortcut
  content/                 Runs inside amazon.com pages
    utils.js               parsePrice, detectCurrency, cleanText
    extractors/generic.js  schema.org Product reader (JSON-LD, microdata, meta tags)
    extractors/amazon.js   Amazon extractor (ASIN, title, price strategies)
    content.js             Picks an extractor, answers the panel, reports watched prices
  sidepanel/               The side panel (opened from the toolbar icon)
    sidepanel.html         Markup for every state (all styling in sidepanel.css)
    api.js                 Data layer: getDetection(), getPreferences(), getPrediction()
    render.js              Rendering layer: fills in the markup
    theme.js               Picks the seasonal and coin color blends
    sliders.js             The three sliders, holiday badge, confidence words
    watchlist-ui.js        The context button, calendar link, watched items, check price now
    sidepanel.js           Controller: follows the active tab, history polling, dev tools
  icons/                   Coin icon: SVG sources, exported PNGs, export-icons.sh
  fonts/                   Inter (variable, Latin) with its OFL license file
  mock/                    Fake /predict responses for dev tools
design/screenshots/        Design review screenshots (not bundled with the extension)
```

When the panel opens, it asks the active tab's content script for the product. It then POSTs the product and the three slider values to `POST /predict`, and draws the card. Moving a slider re-requests after 300 ms and cancels any request still in flight. Switching tabs, loading a page, or Amazon changing the URL in place (e.g. picking another color) re-runs detection.

### The backend contract

- **Request:** `POST /predict` with `{ ...product, preferences }`, where preferences are `min_savings_pct` (1–30 from the slider; the backend allows 1–50), `deadline_days` (1–90) and `min_confidence_pct` (50–95, the schema's limits). Slider defaults are 5%, 14 days and 65%.
- **Response:**
  - `predicted_low_usd` and `best_day` appear as "predicted lowest price: $X on DATE".
  - The expected drop appears in "why?" only on wait cards.
  - When `data_source` is `"simulated"`, `"mixed"` or `"mock"`, a note says what the estimate is based on.
- **`history_status: "fetching"`:** the panel shows the forecast with "loading real price history…". It polls the cheap `GET /history-status/{asin}` every 30 seconds, at most 4 times, and re-requests `/predict` once the status changes.
- **Errors:** requests time out after 10 seconds. A backend that isn't running, a timeout, a 422 (with the backend's message) and any other failure each get a message, with **try again**.

Each `/predict` for a new product adds labeled simulated history to `data/processed/price_history.json`, and may start a background history fetch.

## Design

Top to bottom:

1. **Product line:** small, the title and the current price.
2. **Verdict card:**
   - The verdict in extra-bold Inter, with **why?** beside it and the penny coin on the right (hover to toss it), then "predicted lowest price: … on …".
   - **why?** expands the backend's explanation, the typical drop (wait cards only) and "forecast reliability: …" inside the card.
   - "wait" and "buy now" sit on one line. A leaning verdict shows "leaning" large, with the verdict words smaller and stacked beside it.
   - The card is always the same height, so nothing below moves, and a short fade plays when the verdict changes.
   - "wait" uses the text color, "buy now" emerald, and any leaning verdict grey.
3. **Data-source note:** when the estimate isn't all real price history.
4. **Chance line:** e.g. "90% chance you'll save $0.06+ (1%) by nov 13."
5. **Sliders:** each value is right-aligned on its label's line.
   - **"when do you want it by?":** any day from 1 to 90, with a holiday badge within 2 days of Halloween, Black Friday, Christmas or New Year's Day.
   - **"how much do you want to save?":** 1–30%, on a copper → silver → gold track.
   - **"how sure do you want to be?":** 50–95%, with words from `CONFIDENCE_LEVELS` in `sliders.js`: up to 64 low, up to 79 medium, then high.
6. **The button:** "wait & watch" saves a watch, then reads "watching" (click again to stop) or "update watch". On buy now, "buy now at $X" scrolls the page to Amazon's own buy button and closes the panel.
7. **Watch confirmation:** "add to google calendar: we'll tell you if it drops 1% before nov 13."
8. **see watched items:** once, near the bottom, on every page. It opens the list, with remove and close.
9. **Brand mark:** "penny", one bronze circle per letter.

All text is lowercase (CSS `text-transform`). Everything uses Inter, bundled in `extension/fonts/` with its OFL license. The deadline's season sets the whole panel: drifting blurred blobs behind frosted glass cards. December is a discrete dark theme. With **prefers-reduced-motion**, the blobs don't drift, the coin doesn't toss, and colors switch without fading.

### Where to adjust things

All colors are custom properties in the "Colors" section of `extension/sidepanel/sidepanel.css`:

- **Text, glass, tags and tracks:** the first `:root` block (light) and `:root[data-theme="dark"]` (December).
- **Verdict:** `--verdict-*`.
- **Button:** `--button-*`.
- **Seasons:** `--season-<name>-1/-2/-3` and `--season-<name>-base`.
- **Coins and the savings track:** `--coin-*`.
- **Confidence track:** `--confidence-track-*`.
- **Brand mark:** `--brand-key-*`.

When each season applies, and which months are dark, is set in `extension/sidepanel/theme.js`. The coin's "p" offset is `--coin-letter-offset` on `.coin-stage`, and the brand mark's letter case is the `text-transform` on `.brand-mark`.

With the current values, the worst-case contrast over a full-strength seasonal blob (New Year) is muted text at 5.7:1 and body text at 8.8:1. If you make the blobs stronger or the glass more transparent, recheck it.

### Icons

`extension/icons/penny.svg` is the coin at 32, 48 and 128px (also used for notifications). `penny-small.svg` is the simplified 16px toolbar icon. After editing either one, re-export the PNGs:

```bash
sh extension/icons/export-icons.sh
```

### Screenshots

`design/screenshots/` has the design review images (they're not part of the extension): the verdict states, `why-open`, `watch-confirmation`, `watched-items-open`, the panel at 320px, the holiday and season looks, the coin, the brand mark and the icons. Some older season and holiday shots still show earlier layouts.
