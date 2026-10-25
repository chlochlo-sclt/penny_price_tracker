// Background service worker: opens the side panel from the toolbar icon,
// checks watched products' prices sparingly, and shows the price-drop
// notification.
//
// MV3 service workers are stopped when idle and restarted for each event,
// so nothing here is kept in memory between events: every handler reads the
// watches from storage, and an alarm (not a setInterval) drives the checks.
//
// Saving Apify credits (each uncached GET /watch-check may scrape Amazon):
//   - one alarm, every WATCH_CHECK_INTERVAL_HOURS (12 h); never a tight loop
//   - a watch is skipped if it was checked in the last 12 h (attempts count),
//     and never checked again once its target is hit or its deadline passed
//   - install, reload and browser startup check only watches that are already
//     overdue (12 h+ since their last check, or since they were created)
//   - at most WATCH_CHECKS_PER_DAY (5) backend checks a day, all watches
//     together, counted in storage
//   - 503s and network errors are recorded and wait for the next scheduled
//     check: no retries
//   - the side panel never calls /watch-check; only the alarm and the
//     dev-tools "check price now" button do
//   - visiting a watched product's page updates it for free (PRODUCT_SEEN)
importScripts("../shared/config.js", "../shared/storage.js", "../shared/dates.js", "../shared/watchlist.js");

// Clicking the toolbar icon opens the side panel (manifest.json has no
// popup). Chrome remembers this setting, but setting it on every worker
// start keeps it right after updates.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("penny couldn't set side panel behavior", err));

const CHECK_ALARM = "check-watches";
const ICON_URL = chrome.runtime.getURL("icons/icon-128.png");
// Unpacked (developer) installs have no update_url in their manifest.
const IS_DEV_INSTALL = !chrome.runtime.getManifest().update_url;

// ---- Price source: GET /watch-check ---------------------------------------

/**
 * Today's price and whether it hit the target, from the backend:
 *   GET /watch-check/{asin}?target_price=17.50&deadline=2026-11-20
 *   → { asin, price, currency, title, as_of, cached, target_price,
 *       target_hit, days_left, buy_reminder }
 * deadline_date is already a local YYYY-MM-DD (the backend answers 422
 * otherwise). 503 means price checks are off or Apify failed. buy_reminder
 * is ignored: the Google Calendar event covers the deadline. Throws on any
 * failure.
 */
async function fetchWatchCheck(watch) {
  const query = `target_price=${encodeURIComponent(watch.target_price)}&deadline=${encodeURIComponent(watch.deadline_date)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}/watch-check/${encodeURIComponent(watch.product_id)}?${query}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(`HTTP ${response.status}${typeof body?.detail === "string" ? `: ${body.detail}` : ""}`);
    }
    const body = await response.json();
    if (!Number.isFinite(body?.price)) throw new Error("no price in the /watch-check answer");
    return body;
  } catch (err) {
    throw err.name === "AbortError" ? new Error(`no answer after ${REQUEST_TIMEOUT_MS / 1000}s`) : err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Deciding and notifying -----------------------------------------------

/**
 * Shows the price-drop notification if the target was hit and it hasn't
 * been shown for this watch yet, then marks the watch done (it is never
 * checked again). One path for every source:
 *   "watch-check"  a real backend check (uses its target_hit)
 *   "page"         the price on the product page the user is visiting
 *   "simulation"   the dev shortcut's pretend price (never saved)
 * Returns true if it notified.
 */
async function evaluateWatch(watch, price, { source, targetHit = price <= watch.target_price }) {
  if (!targetHit || watch.notified?.drop) return false;
  await showDropNotification(watch, price);
  await updateWatch(watch.product_id, { notified: { drop: true } });
  console.log(`penny${source === "simulation" ? " [simulation]" : ""}: target hit for ${watch.product_id} (${source}), notified`);
  return true;
}

/**
 * One backend check for one watch: counts it against today's cap first (an
 * uncached check costs credits even if it fails), records the result or
 * the error on the watch, then evaluates. Never retries.
 */
async function runBackendCheck(watch, now = new Date()) {
  const used = await useCheckBudget(now);
  const checkedAt = now.toISOString();
  try {
    const result = await fetchWatchCheck(watch);
    const updated = await updateWatch(watch.product_id, {
      last_price: result.price,
      last_checked_at: checkedAt,
      last_check: { source: "watch-check", ok: true, cached: Boolean(result.cached), as_of: result.as_of, at: checkedAt },
    });
    const notified = await evaluateWatch(updated ?? watch, result.price, { source: "watch-check", targetHit: Boolean(result.target_hit) });
    return { ok: true, price: result.price, cached: Boolean(result.cached), target_hit: Boolean(result.target_hit), notified, used };
  } catch (err) {
    const error = String(err?.message ?? err);
    await updateWatch(watch.product_id, {
      last_checked_at: checkedAt,
      last_check: { source: "watch-check", ok: false, error, at: checkedAt },
    });
    console.warn(`penny: /watch-check for ${watch.product_id} failed (${error}); waiting for the next scheduled check`);
    return { ok: false, error, used };
  }
}

/** Checks every watch that is due, within today's cap. */
async function checkDueWatches(reason) {
  const now = new Date();
  const due = (await getWatches()).filter((watch) => isWatchDue(watch, now));
  if (due.length === 0) {
    console.log(`penny: watch checks (${reason}): nothing due`);
    return;
  }
  for (const [i, watch] of due.entries()) {
    const budget = await getCheckBudget(now);
    if (budget.count >= WATCH_CHECKS_PER_DAY) {
      console.warn(`penny: daily cap of ${WATCH_CHECKS_PER_DAY} /watch-check calls reached; ${due.length - i} due watch(es) wait for the next scheduled check`);
      return;
    }
    await runBackendCheck(watch, now);
  }
}

// ---- Notification ---------------------------------------------------------
// The ID looks like "drop:B0DM37H7G6" so click handlers can find the watch.

const BUTTONS = [{ title: "Buy now" }, { title: "Keep waiting" }];

function shortTitle(title) {
  const clean = (title || "This item").trim();
  return clean.length > 40 ? `${clean.slice(0, 39).trimEnd()}…` : clean;
}

const formatUsd = (value) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

async function showDropNotification(watch, price) {
  await chrome.notifications.create(`drop:${watch.product_id}`, {
    type: "basic",
    iconUrl: ICON_URL,
    title: "it hit your target price, buy now",
    message: `${shortTitle(watch.title)} is now ${formatUsd(price)} (your target: ${formatUsd(watch.target_price)}).`,
    buttons: BUTTONS,
    priority: 2,
  });
}

async function openProductFor(notificationId) {
  const productId = notificationId.split(":")[1];
  const watch = await getWatch(productId);
  if (watch?.url) await chrome.tabs.create({ url: watch.url });
  chrome.notifications.clear(notificationId);
}

chrome.notifications.onClicked.addListener(openProductFor);

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) openProductFor(notificationId); // "Buy now"
  else chrome.notifications.clear(notificationId); // "Keep waiting"
});

// ---- Alarm ----------------------------------------------------------------

async function ensureAlarm() {
  // Alarms survive worker restarts. Only (re)create it if it's missing or
  // has an old period, so reloads don't keep pushing the next check back;
  // the first run is a full period away, never immediate.
  const period = WATCH_CHECK_INTERVAL_HOURS * 60;
  const existing = await chrome.alarms.get(CHECK_ALARM);
  if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create(CHECK_ALARM, { delayInMinutes: period, periodInMinutes: period });
  }
}

// Install, reload (onInstalled) and browser startup: make sure the alarm
// exists, and check only watches that are already overdue (12 h+).
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarm();
  await checkDueWatches(`onInstalled: ${reason}`);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await checkDueWatches("browser startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) checkDueWatches("alarm");
});

// ---- Free updates from the page -------------------------------------------

/**
 * The content script reports the product (and price) it detected. If it's
 * an active watch, that price updates the watch and is checked against the
 * target locally, with no backend call; it counts as a check, so the next
 * backend check waits another 12 h.
 */
async function onProductSeen(product) {
  if (!product?.product_id || !Number.isFinite(product.price)) return;
  const watch = await getWatch(product.product_id);
  if (!watch || !isWatchActive(watch)) return;
  const at = new Date().toISOString();
  const updated = await updateWatch(watch.product_id, {
    last_price: product.price,
    last_checked_at: at,
    last_check: { source: "page", ok: true, at },
  });
  await evaluateWatch(updated ?? watch, product.price, { source: "page" });
}

// ---- Dev only: demo shortcut and "check price now" ------------------------

/**
 * SIMULATION (dev installs only): the "simulate-price-drop" command in
 * manifest.json (Alt+Shift+P by default). Takes the most recently created
 * active watch and runs the real evaluate-and-notify path with a pretend
 * price just below its target, so the real notification and its buttons
 * work. The pretend price is never saved.
 */
async function simulatePriceDrop() {
  if (!IS_DEV_INSTALL) {
    console.log("penny: the simulate shortcut only works in unpacked (dev) installs");
    return;
  }
  const active = (await getWatches()).filter((watch) => isWatchActive(watch));
  const watch = active.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!watch) {
    console.log("penny [simulation]: no active watch to simulate a price drop for");
    return;
  }
  const pretendPrice = Math.max(0.01, Math.round((watch.target_price - 0.01) * 100) / 100);
  console.log(`penny [simulation]: pretending ${watch.product_id} costs ${pretendPrice} (target ${watch.target_price}); this price is not saved`);
  await evaluateWatch(watch, pretendPrice, { source: "simulation" });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "simulate-price-drop") simulatePriceDrop();
});

/**
 * Dev tools "check price now": exactly one /watch-check call for one watch,
 * at most once every DEV_CHECK_COOLDOWN_MINUTES, and within the daily cap.
 */
async function checkWatchNow(productId) {
  if (!IS_DEV_INSTALL) return { ok: false, error: "only available in unpacked (dev) installs" };
  const now = new Date();
  const lastAt = await storageGet("local", DEV_CHECK_AT_KEY, null);
  const readyAt = lastAt ? Date.parse(lastAt) + DEV_CHECK_COOLDOWN_MINUTES * 60 * 1000 : 0;
  if (now < readyAt) return { ok: false, error: `wait until ${new Date(readyAt).toLocaleTimeString()}` };
  const budget = await getCheckBudget(now);
  if (budget.count >= WATCH_CHECKS_PER_DAY) {
    console.warn(`penny: daily cap of ${WATCH_CHECKS_PER_DAY} /watch-check calls reached; "check price now" refused`);
    return { ok: false, error: `today's cap of ${WATCH_CHECKS_PER_DAY} checks is reached` };
  }
  const watch = await getWatch(productId);
  if (!watch) return { ok: false, error: "that item is no longer watched" };
  await storageSet("local", DEV_CHECK_AT_KEY, now.toISOString());
  return runBackendCheck(watch, now);
}

// ---- Messages -------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PRODUCT_SEEN") {
    onProductSeen(message.product).catch((err) => console.warn("penny: page price update failed", err));
  } else if (message?.type === "CHECK_WATCH_NOW") {
    checkWatchNow(message.product_id)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true; // keeps the channel open for the async sendResponse
  } else if (message?.type === "WATCH_REMOVED") {
    chrome.notifications.clear(`drop:${message.product_id}`);
  }
});
