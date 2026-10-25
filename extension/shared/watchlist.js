// Watched products ("Wait & watch"), stored in chrome.storage.local under
// "watches" as { [product_id]: watch }. Shared by the side panel (adds/removes)
// and the background worker (checks prices, marks what it has notified).
//
// A watch:
//   product_id, title, url
//   price_at_watch   price when the user clicked Wait & watch
//   target_pct       savings goal from the slider (%)
//   target_price     price_at_watch reduced by target_pct
//   deadline_date    "YYYY-MM-DD", from the deadline slider
//   created_at       ISO timestamp
//   notified         { drop }: the price-drop notification was shown; the
//                    watch is then done and never checked again
//   last_price       last known real price (from /watch-check or the page)
//   last_checked_at  when the price was last checked (attempts count too)
//   last_check       { source, ok, cached, error, at } of that check

const WATCHES_KEY = "watches";

async function getWatchMap() {
  return storageGet("local", WATCHES_KEY, {});
}

/** All watches, oldest first. */
async function getWatches() {
  return Object.values(await getWatchMap()).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function getWatch(productId) {
  return (await getWatchMap())[productId] ?? null;
}

/** Builds a watch for a detected product and the current slider values. */
function createWatch(product, { min_savings_pct, deadline_days }) {
  return {
    product_id: product.product_id,
    title: product.title,
    url: product.url,
    price_at_watch: product.price,
    target_pct: min_savings_pct,
    target_price: Math.round(product.price * (1 - min_savings_pct / 100) * 100) / 100,
    deadline_date: toIsoDate(addDays(startOfDay(), deadline_days)),
    created_at: new Date().toISOString(),
    notified: { drop: false },
    last_price: null,
    last_checked_at: null,
    last_check: null,
  };
}

/** Still worth checking: the target hasn't been hit and the deadline hasn't passed. */
function isWatchActive(watch, now = new Date()) {
  return !watch.notified?.drop && daysBetween(now, parseIsoDate(watch.deadline_date)) >= 0;
}

/**
 * Due for a background check: active, and not checked in the last
 * WATCH_CHECK_INTERVAL_HOURS. A watch that was never checked counts from when
 * it was created, so creating a watch (or reloading the extension right
 * after) never triggers an immediate check.
 */
function isWatchDue(watch, now = new Date()) {
  const since = Date.parse(watch.last_checked_at ?? watch.created_at);
  return isWatchActive(watch, now) && now - since >= WATCH_CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
}

// ---- Daily cap on backend checks -----------------------------------------
// { date: "YYYY-MM-DD" (local), count } in chrome.storage.local; a new day
// starts again at 0.

const CHECK_BUDGET_KEY = "watchCheckBudget";

async function getCheckBudget(now = new Date()) {
  const today = toIsoDate(now);
  const stored = await storageGet("local", CHECK_BUDGET_KEY, null);
  return stored?.date === today ? stored : { date: today, count: 0 };
}

/** Counts one backend check against today's cap. Returns the new count. */
async function useCheckBudget(now = new Date()) {
  const budget = await getCheckBudget(now);
  budget.count += 1;
  await storageSet("local", CHECK_BUDGET_KEY, budget);
  return budget.count;
}

/** Adds a watch, replacing any existing watch for the same product. */
async function saveWatch(watch) {
  const watches = await getWatchMap();
  watches[watch.product_id] = watch;
  return storageSet("local", WATCHES_KEY, watches);
}

/** Merges `changes` into a stored watch. Returns the updated watch, or null if it's gone. */
async function updateWatch(productId, changes) {
  const watches = await getWatchMap();
  if (!watches[productId]) return null;
  watches[productId] = { ...watches[productId], ...changes };
  await storageSet("local", WATCHES_KEY, watches);
  return watches[productId];
}

async function removeWatch(productId) {
  const watches = await getWatchMap();
  delete watches[productId];
  return storageSet("local", WATCHES_KEY, watches);
}
