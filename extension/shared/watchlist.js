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
//   notified         { drop, deadline }: which notifications were already
//                    shown, so each event notifies only once
//   last_price, last_checked_at   last successful price check, if any

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
    notified: { drop: false, deadline: false },
    last_price: null,
    last_checked_at: null,
  };
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
