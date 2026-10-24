// The popup side of "Wait & watch": the Buy now / Wait & watch buttons on
// the card, the "Watching" list, and the dev-tools buttons that simulate a
// price drop or an approaching deadline. Storage lives in
// shared/watchlist.js; notifications come from background/background.js.
const WatchlistUI = (() => {
  // Set by init(): the detected product and the current slider values.
  let getProduct = () => null;
  let getGoal = () => null;

  const deadlineText = (watch) => formatShortDate(parseIsoDate(watch.deadline_date));

  // ---- Card buttons -------------------------------------------------------

  /** Updates the Wait & watch button for the current product and goal. */
  async function refresh() {
    const product = getProduct();
    const goal = getGoal();
    const button = $("watch-button");
    const noGoal = goal?.min_savings_pct === 0;
    button.disabled = !product || noGoal;
    button.title = noGoal ? "Set a savings goal above 0% to watch for a drop" : "";
    const existing = product ? await getWatch(product.product_id) : null;
    button.textContent = existing ? "Update watch" : "Wait & watch";
  }

  async function onWatchClick() {
    const product = getProduct();
    if (!product) return;
    const watch = createWatch(product, getGoal());
    const confirmation = $("watch-confirmation");
    confirmation.hidden = false;
    if (await saveWatch(watch)) {
      confirmation.className = "watch-confirmation";
      confirmation.textContent = `Watching: we'll tell you if it drops ${watch.target_pct}% before ${deadlineText(watch)}.`;
    } else {
      confirmation.className = "watch-confirmation watch-confirmation--error";
      confirmation.textContent = "Couldn't save this watch. Try again.";
    }
    await refresh();
    await renderList();
  }

  // ---- Watching list ------------------------------------------------------

  function statusText(watch) {
    if (watch.notified?.drop) return "Target price reached";
    if (daysBetween(new Date(), parseIsoDate(watch.deadline_date)) < 0) return "Deadline passed";
    if (watch.notified?.deadline) return "Deadline reminder sent";
    if (watch.last_price != null) return `Last checked price: ${formatMoney(watch.last_price)}`;
    return null;
  }

  async function onRemove(productId) {
    await removeWatch(productId);
    // Clear any notification still showing for it (background owns those).
    globalThis.chrome?.runtime?.sendMessage?.({ type: "WATCH_REMOVED", product_id: productId }).catch(() => {});
    await refresh();
    await renderList();
  }

  async function renderList() {
    const watches = await getWatches();
    $("watchlist").hidden = watches.length === 0;
    const list = $("watchlist-items");
    const template = $("watchlist-item-template");
    list.replaceChildren(
      ...watches.map((watch) => {
        const item = template.content.firstElementChild.cloneNode(true);
        const link = item.querySelector(".watchlist-item-title");
        link.textContent = watch.title || watch.product_id;
        link.href = watch.url;
        item.querySelector(".watchlist-item-target").textContent =
          `Target ${formatMoney(watch.target_price)} (−${watch.target_pct}%) · by ${deadlineText(watch)}`;
        const status = statusText(watch);
        const statusEl = item.querySelector(".watchlist-item-status");
        statusEl.hidden = !status;
        statusEl.textContent = status ?? "";
        const remove = item.querySelector(".watchlist-item-remove");
        remove.setAttribute("aria-label", `Stop watching ${watch.title || watch.product_id}`);
        remove.addEventListener("click", () => onRemove(watch.product_id));
        return item;
      }),
    );
    renderDevWatchOptions(watches);
  }

  // ---- Dev tools: simulate notifications ----------------------------------

  function renderDevWatchOptions(watches) {
    const select = $("dev-watch");
    const previous = select.value;
    select.replaceChildren(
      ...watches.map((watch) => new Option(watch.title || watch.product_id, watch.product_id)),
    );
    if (watches.some((w) => w.product_id === previous)) select.value = previous;
    const none = watches.length === 0;
    select.disabled = none;
    $("dev-simulate-drop").disabled = none;
    $("dev-simulate-deadline").disabled = none;
    if (none) $("dev-simulate-status").textContent = "Watch an item first.";
  }

  /** Asks the background worker to run its real notification path with faked conditions. */
  async function simulate(event) {
    const status = $("dev-simulate-status");
    if (!globalThis.chrome?.runtime?.sendMessage) {
      status.textContent = "Needs the installed extension (no background worker here).";
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage({
        type: "SIMULATE_WATCH_EVENT",
        event,
        product_id: $("dev-watch").value,
      });
      status.textContent = !result?.ok
        ? `Failed: ${result?.error ?? "no response from the background worker"}`
        : result.fired
          ? `Sent the "${result.fired}" notification.`
          : "Ran the check, but no notification was due.";
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    }
    await renderList();
  }

  // ---- Setup --------------------------------------------------------------

  async function init(options) {
    getProduct = options.getProduct;
    getGoal = options.getGoal;

    $("buy-now-button").addEventListener("click", () => window.close()); // the user buys on the page
    $("watch-button").addEventListener("click", onWatchClick);
    $("dev-simulate-drop").addEventListener("click", () => simulate("drop"));
    $("dev-simulate-deadline").addEventListener("click", () => simulate("deadline"));

    // The background worker updates watches (last price, notified flags).
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes[WATCHES_KEY]) renderList();
    });

    await renderList();
    await refresh();
  }

  return { init, refresh };
})();
