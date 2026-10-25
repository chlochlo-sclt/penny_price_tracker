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

| Product | ASIN | Page | Why this one |
|---|---|---|---|
| Instant Pot | `B00FLYWNYQ` | https://www.amazon.com/dp/B00FLYWNYQ | Real Black Friday sale date, 9 years of history |
| CeraVe | `B00TTD9BRC` | https://www.amazon.com/dp/B00TTD9BRC | Best backtest accuracy, high reliability |
| Crest | `B00AHAWWO0` | https://www.amazon.com/dp/B00AHAWWO0 | 14 years of history; the 73% wait-accuracy result |
| AirPods Pro 2 | `B0BDHWDR12` | https://www.amazon.com/dp/B0BDHWDR12 | Honest contrast: medium reliability, no edge |
| Keurig K-Classic | `B018UQ5AMS` | https://www.amazon.com/dp/B018UQ5AMS | 10 years of history; good live-fetch demo |
| Sony headphones | `B0HFB8N519` | https://www.amazon.com/dp/B0HFB8N519 | Thin history, so `data_source` is `mixed` |

Avoid the Mead notebook (`B0028N6PSS`) in demos: its backtest is badly calibrated
(predicted 12%, actual 22%).

To show a **wait** verdict reliably, use the Instant Pot with a 7% savings goal, a
75-day deadline and 50% confidence — a 64% chance, so there's comfortable headroom.
Drag confidence to 80% to flip it to buy now. (AirPods at 3% / 35 days is "buy now"
at 65% and "wait" at 50%, but that margin is thin enough to move with the price.)

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

Each `/predict` for a new product adds labeled simulated history to Tiger Data (or
`data/processed/price_history.json` if the database isn't configured), and may start a
background history fetch.

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

## The backend

Python, FastAPI, in `app/`. Price history comes from Apify and lives in Tiger Data.

### Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pytest                 # should be all green
```

`.env` in the repo root:

```
APIFY_API_TOKEN=...        # required for any price fetching
TIGER_DATABASE_URL=...     # Tiger Data; falls back to a local JSON file if absent or down
LIVE_FETCH=0               # 1 lets /predict auto-fetch history for unseen products
PRICE_CHECKS=1             # 0 blocks the watchlist's current-price scrapes
```

Two separate Apify budgets, worth keeping straight:

| | Limit | Resets | Spent by |
|---|---|---|---|
| Keepa actor (history) | 50 runs total | Never | `fetch_history`, live fetch |
| Apify platform (current price) | $5/month | Monthly | `/watch-check`, `scrape_apify` |

`LIVE_FETCH=0` protects the scarce one. Turn it on for a demo, off while developing —
otherwise browsing Amazon with the panel open spends Keepa runs.

### Commands

```bash
uvicorn app.main:app --reload --port 8000     # run the API
python -m app.fetch_history <ASINs>           # pull Keepa history (5 ASINs per run)
python -m app.migrate_to_tiger                # copy local JSON history into Tiger Data
python -m app.retune_tiger                    # rebuild the hypertable with year-wide chunks
python -m app.backtest <ASIN> --deadline 35 --savings 10
python -m app.backtest_all --charts           # the accuracy table below
python -m app.best_day_check <ASINs>          # is a product's "best day" real?
```

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /predict` | The verdict, from the price the extension read off the page |
| `GET /history-status/{asin}` | Cheap poll while real history is fetching. Never starts a fetch. |
| `GET /watch-check/{asin}` | Today's price, target-hit check, 3-day deadline nudge |
| `GET /predict` | Fixed mock response, for front-end work without the backend |

### Storage

Tiger Data (TimescaleDB) is the store; a local JSON file is the fallback and backup.

```sql
CREATE TABLE prices (
  product_id TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  price      NUMERIC(12,2) NOT NULL,
  currency   TEXT,
  source     TEXT NOT NULL,       -- historical | scraped | simulated
  title      TEXT,
  data_type  TEXT,                -- which Keepa series it came from
  PRIMARY KEY (product_id, ts, source)
);
```

Writes are append-only with `ON CONFLICT DO NOTHING`, so re-running a fetch never
duplicates or loses rows. A product's rows are cached in-process for 30 seconds,
because one `/predict` reads them three times and each uncached read is a round
trip to a remote database.

If the database is unreachable the API serves from JSON, and after one failure it
skips the database for 60 seconds rather than waiting on a connection timeout
every request — a hostname resolving to six addresses means six timeouts.

**Chunk tuning.** Price histories reach back to 2011, and TimescaleDB chunks a
hypertable by time, seven days by default. That produced 582 chunks, and our
access pattern ("one product's whole history, no time bound") has to plan across
all of them: `/predict` took nine seconds. Year-wide chunks bring it to ~16.
`python -m app.retune_tiger` does the rebuild, backing every row up and reading
the backup back before touching the table.

### Data sources

| `data_source` | Means |
|---|---|
| `real` | 60+ days of real history; synthetic rows are dropped entirely |
| `mixed` | Real history, but under 60 days, so synthetic rows fill the gap |
| `simulated` | Nothing real yet — all synthetic, and labeled |
| `mock` | The fixed `GET /predict` response |

Two Apify actors: `radeance/keepa-scraper` with `include_price_history` for
multi-year history, and Apify's official e-commerce scraper for today's price
(the watchlist needs it, since the user isn't on the page when their alarm fires).

Keepa returns up to 17 price series per product. `new` is the lowest price across
all sellers and sits below the page price; `buybox` is what a shopper actually
sees. `pick_series` chooses automatically: longest time span, and among those
within 80% of the longest, the densest.

With `LIVE_FETCH=1`, a product with no stored history gets an answer immediately
(labeled `simulated`) and a background Keepa fetch starts. `history_status` goes
`fetching` → `ready`, and the next request serves real data. **One run per
product, ever** — a completed fetch is remembered even if Keepa held less than
our 60-day threshold, and the check-and-claim happens under one lock, so a burst
of requests can't start duplicate fetches.

---

## How the forecast works

Given a savings target, a deadline and a confidence level, the backend answers
buy now or wait.

It asks one question of every past day: *starting here, did the price fall at
least this much within this many days?* The share of past windows where it did is
`p_drop`. If that clears the user's confidence level, the answer is wait.

Two adjustments apply **only when they prove themselves** on that product's own
history:

- **Time of year** — windows starting within ±21 days of today's date in other
  years, weighted more heavily. Validated leave-one-year-out.
- **Price position** — where today's price sits against its own 90-day median.
  Validated forward-only.

Each must cut prediction error by at least 3% on that product's past, or it's
discarded and the plain historical rate is used. This is why the same code
reports `confidence: high` for CeraVe and `medium` for AirPods: it checks whether
it has anything to add, per product, and says so.

A weekday adjustment applies only when the deadline is under a week, since a
longer window already contains every weekday.

### The best day

Two methods, and the honest one wins.

The naive approach asks how far into a window the low usually landed, and takes
the median. Measured on real data, those offsets are spread evenly across the
window, so the median is the window's *midpoint* — a date carrying no
information. Black Friday is invisible to it.

So penny asks the calendar question instead: on this day-of-year, in past years,
was this product actually cheaper than in the surrounding three weeks? A date
qualifies only if it is at least 3% below that local baseline **and** was cheaper
in at least 60% of comparable years, with at least 3 years to compare.

The Instant Pot qualifies: Nov 27, about 10% below its surrounding weeks, in 5 of
the last 9 years. Flat-priced products like Crest and CeraVe don't, and the
explanation says "any time in your N days" rather than inventing a day.

`python -m app.best_day_check <ASIN>` shows the distribution and the verdict.

### Data cleaning

Amazon's buy-box series contains glitches: the AirPods history had 17 points at
$99.99 on a ~$264 item, each lasting minutes. Read naively, those are enormous
fake price drops.

Low prices are judged by **duration, not depth**. A price below 55% of the recent
median is dropped only if it doesn't last 12 hours, so a genuine half-price week
survives and a 20-minute flicker doesn't. Depth alone would have deleted real
deep discounts on exactly the products where big sales are the signal.

### The simulator

Products with no real history get a year of synthetic daily prices, every row
labeled `source="simulated"`: a slow mean-reverting wobble, a small weekday
effect, hardcoded US sale windows (Prime Day, back-to-school, Black Friday,
Cyber Monday, mid-December) with randomised depth, and occasional short promos.
It is seeded from the ASIN, so a product's synthetic history is stable, and
rescaled so its last value equals the real price on the page.

**It has Black Friday built in.** A simulated product will therefore produce
plausible-looking seasonal advice, which is circular — the model is finding a
pattern we planted. Only the backtest on *real* products is evidence.

---

## How well it works

Most price predictors don't check. `app/backtest.py` replays history
walk-forward: for each past day it forecasts using **only** what was known then,
then checks what actually happened. `app/backtest_all.py` does it for every
product and prints one table.

The bar to beat is an honest baseline: always guessing the drop rate seen so far.

**14-day deadline, 5% savings target:**

| Product | Real history | Test days | Actual | Predicted | vs baseline | Spread |
|---|---|---|---|---|---|---|
| CeraVe (B00TTD9BRC) | 3,174 days | 994 | 28% | 27% | **+8%** | 0.52 |
| Crest (B00AHAWWO0) | 5,067 days | 1,604 | 20% | 19% | +3% | 0.31 |
| Mead notebook (B0028N6PSS) | 5,541 days | 1,677 | 22% | 12% | +1% | 0.33 |
| AirPods Pro (B0BDHWDR12) | 1,505 days | 438 | 29% | 29% | 0% | 0.00 |
| Instant Pot (B00FLYWNYQ) | 3,253 days | 1,021 | 29% | 30% | −1% | 0.13 |

**Three of six products beat the baseline. Three didn't.**

Strongest single result: at a 35-day deadline and a 10% target, Crest wait
verdicts issued at 65% confidence were followed by a real drop **73%** of the
time.

`spread` is how much predictions vary. CeraVe's 0.52 means it genuinely
distinguishes days. AirPods' 0.00 means it gave the same number every day for 438
test days — perfectly calibrated (29% predicted, 29% actual) and completely
uninformative. A forecast needs both calibration (the number is right) and
discrimination (it changes when conditions change).

The pattern: **everyday consumables with frequent promotional cycles are
predictable; electronics and big-ticket items are not.**

### What we tried that didn't work

Measured on AirPods, which showed no skill, to find out why:

| Candidate signal | Separation (0.5 = none) |
|---|---|
| Price vs its 90-day low | 0.59 |
| Price vs its 90-day median | 0.57 |
| Days since the last price cut | 0.54 |
| Days until Black Friday / Prime Day | 0.50 |

A logistic regression on the strongest came out **12–14% worse than the
baseline** walk-forward, so that 0.59 is noise that doesn't survive honest
testing. A sale-frequency calendar doesn't help either: AirPods had 73 price cuts
spread evenly across the year, with more in August and September than November.
(Its *price level* around Black Friday is still lower, which is what the
calendar best-day method finds — a different question.)

Lightning deals were considered and rejected: 4 data points in 5 years for the
Instant Pot, 16 for Crest. Far too sparse.

### Known limitations

- **Overlapping test windows.** Consecutive test days share most of their outcome
  window, so 994 test days are not 994 independent samples. The effect is real
  but weaker evidence than the sample size suggests.
- **Selection.** Six products, and the best was identified after looking. Treat
  "+8%" as indicative, not significant.
- **One product is badly calibrated.** The notebook predicted 12% where 22%
  happened. A future version should gate wait verdicts on a product passing
  calibration, not only on `p_drop`.
- **Buy-box price only.** Coupons and Subscribe & Save are excluded.
- **No product lifecycle.** A successor announcement is probably the most
  reliable cause of a price drop, and it is invisible here. This may be exactly
  why AirPods looks unpredictable.
- **It models drops, not rises.** `interval_high_usd` is capped at today's price,
  so the risk of waiting isn't priced. Measured on AirPods: a 5%+ dip happened in
  29% of 14-day windows, but the price ended 5%+ *higher* 16% of the time. That
  asymmetry is why the confidence floor is 50% — below even odds, a wait would
  advise a bet more likely to lose on a risk we haven't quantified.
- **Arbitrary constants.** The 60-day real-history threshold, the ±21-day
  seasonal window and the 3% skill gate were chosen, not tuned.
