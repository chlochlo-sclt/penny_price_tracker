// Background service worker: opens the side panel from the toolbar icon,
// checks watched products on a timer, and shows price-drop / deadline
// notifications.
//
// MV3 service workers are stopped when idle and restarted for each event,
// so nothing here is kept in memory between events: every handler reads the
// watches from storage, and the alarm (not a setInterval) drives the checks.
importScripts("../shared/config.js", "../shared/storage.js", "../shared/dates.js", "../shared/watchlist.js");

// Clicking the toolbar icon opens the side panel (manifest.json has no
// popup). Chrome remembers this setting, but setting it on every worker
// start keeps it right after updates.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("penny couldn't set side panel behavior", err));

const CHECK_ALARM = "check-watches";
const CHECK_EVERY_MINUTES = 30;
const DEADLINE_WARNING_DAYS = 3;
const ICON_URL = chrome.runtime.getURL("icons/icon-128.png");

// ---- Price source ---------------------------------------------------------

/**
 * The current price for a watched product, or null if we can't tell.
 * This is the one place to change when the price source changes. For now it
 * asks the backend's GET /price/{product_id}, which doesn't exist yet; any
 * failure (404, backend down, unexpected body) is skipped quietly.
 * Expected response: { "price": 123.45 } (a bare number is accepted too).
 */
async function getCurrentPrice(watch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}/price/${encodeURIComponent(watch.product_id)}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const price = typeof body === "number" ? body : Number(body?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Checking watches -----------------------------------------------------

/**
 * Decides whether a watch needs a notification and shows it. Used by both
 * the alarm and the dev-tools simulation, so the demo runs the real logic.
 * `currentPrice` may be null (unknown); `now` is injectable for simulation.
 * Returns "drop", "deadline", or null.
 */
async function evaluateWatch(watch, currentPrice, now = new Date()) {
  const targetHit = currentPrice != null && currentPrice <= watch.target_price;
  if (currentPrice != null) {
    await updateWatch(watch.product_id, { last_price: currentPrice, last_checked_at: now.toISOString() });
  }

  if (targetHit && !watch.notified.drop) {
    await showDropNotification(watch, currentPrice);
    await updateWatch(watch.product_id, { notified: { ...watch.notified, drop: true } });
    return "drop";
  }

  const daysLeft = daysBetween(now, parseIsoDate(watch.deadline_date));
  const deadlineSoon = daysLeft >= 0 && daysLeft <= DEADLINE_WARNING_DAYS;
  if (deadlineSoon && !targetHit && !watch.notified.drop && !watch.notified.deadline) {
    await showDeadlineNotification(watch, daysLeft);
    await updateWatch(watch.product_id, { notified: { ...watch.notified, deadline: true } });
    return "deadline";
  }
  return null;
}

async function checkAllWatches() {
  const now = new Date();
  for (const watch of await getWatches()) {
    // Nothing left to tell the user once the deadline has passed.
    if (daysBetween(now, parseIsoDate(watch.deadline_date)) < 0) continue;
    try {
      await evaluateWatch(watch, await getCurrentPrice(watch), now);
    } catch (err) {
      console.error(`penny checking ${watch.product_id} failed`, err);
    }
  }
}

// ---- Notifications --------------------------------------------------------
// IDs look like "drop:B0DM37H7G6" so click handlers can find the watch.

const BUTTONS = [{ title: "Buy now" }, { title: "Keep waiting" }];

function shortTitle(title) {
  const clean = (title || "This item").trim();
  return clean.length > 40 ? `${clean.slice(0, 39).trimEnd()}…` : clean;
}

const formatUsd = (value) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

async function showDropNotification(watch, currentPrice) {
  const pct = Math.round((1 - currentPrice / watch.price_at_watch) * 100);
  await chrome.notifications.create(`drop:${watch.product_id}`, {
    type: "basic",
    iconUrl: ICON_URL,
    title: `${shortTitle(watch.title)} dropped ${pct}% — buy now`,
    message: `Now ${formatUsd(currentPrice)}, down from ${formatUsd(watch.price_at_watch)}. Your target was ${formatUsd(watch.target_price)}.`,
    buttons: BUTTONS,
    priority: 2,
  });
}

async function showDeadlineNotification(watch, daysLeft) {
  const when = daysLeft === 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
  await chrome.notifications.create(`deadline:${watch.product_id}`, {
    type: "basic",
    iconUrl: ICON_URL,
    title: shortTitle(watch.title),
    message: `Your deadline is ${when} and the price hasn't dropped. Buy now so it arrives in time.`,
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
  // Alarms survive worker restarts; only create it if it's missing, so
  // reinstalls and browser restarts don't keep pushing the next check back.
  if (!(await chrome.alarms.get(CHECK_ALARM))) {
    await chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_EVERY_MINUTES });
  }
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) checkAllWatches();
});

// ---- Messages from the side panel ----------------------------------------

/**
 * Dev tools: fake the conditions for one watched item and run evaluateWatch,
 * so the real notification code runs. Both "already notified" flags are
 * reset first so the demo can be repeated.
 */
async function simulate(event, productId) {
  let watch = await updateWatch(productId, { notified: { drop: false, deadline: false } });
  if (!watch) return { ok: false, error: "That item is no longer watched." };

  if (event === "drop") {
    const fakePrice = Math.round(watch.target_price * 0.98 * 100) / 100;
    return { ok: true, fired: await evaluateWatch(watch, fakePrice) };
  }
  if (event === "deadline") {
    const fakeNow = addDays(parseIsoDate(watch.deadline_date), -DEADLINE_WARNING_DAYS);
    return { ok: true, fired: await evaluateWatch(watch, null, fakeNow) };
  }
  return { ok: false, error: `Unknown event: ${event}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SIMULATE_WATCH_EVENT") {
    simulate(message.event, message.product_id)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true; // keeps the channel open for the async sendResponse
  }
  if (message?.type === "WATCH_REMOVED") {
    chrome.notifications.clear(`drop:${message.product_id}`);
    chrome.notifications.clear(`deadline:${message.product_id}`);
  }
});
