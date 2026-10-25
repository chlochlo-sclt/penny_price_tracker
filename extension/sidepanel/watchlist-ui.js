// The side-panel half of "wait & watch": the one context-dependent button on
// the card, the watch list in "details", and the dev-tools buttons that
// simulate a price drop or an approaching deadline. Storage lives in
// shared/watchlist.js; notifications come from background/background.js.
//
// The button depends on the verdict (set by sidepanel.js after each forecast):
//   buy now / leaning buy now  → "buy now at $X": scrolls the page to its own
//                                buy button (SCROLL_TO_BUY in content.js)
//   wait / leaning wait        → "wait & watch": saves a watch with the
//                                current sliders; then "watching" (click
//                                again to stop), or "update watch" if the
//                                sliders changed since it was saved
const WatchlistUI = (() => {
  // Set by init(): the detected product and the current slider values.
  let getProduct = () => null;
  let getGoal = () => null;
  let recommendation = null; // "buy_now" | "wait" | null

  const deadlineText = (watch) => formatShortDate(parseIsoDate(watch.deadline_date));

  /** Does a saved watch already match the current product and sliders? */
  function matchesGoal(watch, product, goal) {
    const wanted = createWatch(product, goal);
    return watch.target_pct === wanted.target_pct && watch.deadline_date === wanted.deadline_date;
  }

  // ---- The context button -------------------------------------------------

  /** Updates the button for the current verdict, product and goal. */
  async function refresh() {
    const product = getProduct();
    const goal = getGoal();
    const button = $("primary-button");
    button.disabled = !product || !goal || !recommendation;
    button.removeAttribute("aria-pressed");
    if (!product || !recommendation) return;

    if (recommendation === "buy_now") {
      button.className = "primary-button primary-button--buy";
      button.textContent = `buy now at ${formatMoney(product.price, product.currency ?? "USD")}`;
      return;
    }
    const existing = await getWatch(product.product_id);
    if (existing && matchesGoal(existing, product, goal)) {
      button.className = "primary-button primary-button--watching";
      button.textContent = "watching";
      button.setAttribute("aria-pressed", "true");
      button.title = "click to stop watching";
    } else {
      button.className = "primary-button primary-button--watch";
      button.textContent = existing ? "update watch" : "wait & watch";
      button.title = "";
    }
  }

  /** sidepanel.js calls this after each forecast renders. */
  function setRecommendation(value) {
    recommendation = value;
    refresh();
  }

  async function onPrimaryClick() {
    const product = getProduct();
    if (!product) return;
    if (recommendation === "buy_now") {
      // Point the page at its own buy button, then get out of the way.
      await scrollPageToBuyButton();
      window.close(); // closes the side panel
      return;
    }

    const confirmation = $("watch-confirmation");
    const existing = await getWatch(product.product_id);
    if (existing && matchesGoal(existing, product, getGoal())) {
      await stopWatching(product.product_id);
      confirmation.hidden = true;
      return;
    }

    const watch = createWatch(product, getGoal());
    confirmation.hidden = false;
    if (await saveWatch(watch)) {
      confirmation.className = "watch-confirmation";
      confirmation.textContent = `watching: we'll tell you if it drops ${watch.target_pct}% before ${deadlineText(watch)}.`;
    } else {
      confirmation.className = "watch-confirmation watch-confirmation--error";
      confirmation.textContent = "couldn't save this watch. try again.";
    }
    await refresh();
    await renderList();
  }

  // ---- Watch list (inside "details") --------------------------------------

  function statusText(watch) {
    if (watch.notified?.drop) return "target price reached";
    if (daysBetween(new Date(), parseIsoDate(watch.deadline_date)) < 0) return "deadline passed";
    if (watch.notified?.deadline) return "deadline reminder sent";
    if (watch.last_price != null) return `last checked price: ${formatMoney(watch.last_price)}`;
    return "watching";
  }

  async function stopWatching(productId) {
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
          `notify at ${formatMoney(watch.target_price)} or less (−${watch.target_pct}%) · by ${deadlineText(watch)}`;
        const statusEl = item.querySelector(".watchlist-item-status");
        statusEl.hidden = false;
        statusEl.textContent = statusText(watch);
        const remove = item.querySelector(".watchlist-item-remove");
        remove.setAttribute("aria-label", `stop watching ${watch.title || watch.product_id}`);
        remove.addEventListener("click", () => stopWatching(watch.product_id));
        return item;
      }),
    );
    syncDetailsCard();
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
    if (none) $("dev-simulate-status").textContent = "watch an item first.";
  }

  /** Asks the background worker to run its real notification path with faked conditions. */
  async function simulate(event) {
    const status = $("dev-simulate-status");
    if (!globalThis.chrome?.runtime?.sendMessage) {
      status.textContent = "needs the installed extension (no background worker here).";
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage({
        type: "SIMULATE_WATCH_EVENT",
        event,
        product_id: $("dev-watch").value,
      });
      status.textContent = !result?.ok
        ? `failed: ${result?.error ?? "no response from the background worker"}`
        : result.fired
          ? `sent the "${result.fired}" notification.`
          : "ran the check, but no notification was due.";
    } catch (err) {
      status.textContent = `failed: ${err.message}`;
    }
    await renderList();
  }

  // ---- Setup --------------------------------------------------------------

  async function init(options) {
    getProduct = options.getProduct;
    getGoal = options.getGoal;

    $("primary-button").addEventListener("click", onPrimaryClick);
    $("dev-simulate-drop").addEventListener("click", () => simulate("drop"));
    $("dev-simulate-deadline").addEventListener("click", () => simulate("deadline"));

    // The background worker updates watches (last price, notified flags).
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes[WATCHES_KEY]) {
        renderList();
        refresh();
      }
    });

    await renderList();
    await refresh();
  }

  return { init, refresh, setRecommendation };
})();
