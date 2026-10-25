// The side-panel half of "wait & watch": the one context-dependent button on
// the card, the watched-items list, and the dev-tools "check price now"
// button. Storage lives in
// shared/watchlist.js; notifications come from background/background.js.
//
// The button depends on the verdict (set by sidepanel.js after each forecast):
//   buy now / leaning buy now  → "buy now at $X": scrolls the page to its own
//                                buy button (SCROLL_TO_BUY in content.js) and
//                                closes the side panel
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
    const block = $("watch-confirmation-block");
    const existing = await getWatch(product.product_id);
    if (existing && matchesGoal(existing, product, getGoal())) {
      await stopWatching(product.product_id);
      block.hidden = true;
      return;
    }

    const watch = createWatch(product, getGoal());
    block.hidden = false;
    if (await saveWatch(watch)) {
      confirmation.className = "watch-confirmation";
      const link = document.createElement("a");
      link.className = "calendar-link";
      link.href = googleCalendarUrl(watch);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "add to google calendar";
      confirmation.replaceChildren(link, `: we'll tell you if it drops ${watch.target_pct}% before ${deadlineText(watch)}.`);
    } else {
      confirmation.className = "watch-confirmation watch-confirmation--error";
      confirmation.textContent = "couldn't save this watch. try again.";
    }
    await refresh();
    await renderList();
  }

  // ---- "add to google calendar" ---------------------------------------------

  /** The product title, cut at a word boundary so the event title stays short. */
  function shortTitle(title, max = 40) {
    const clean = (title || "this item").replace(/\s+/g, " ").trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : max).trimEnd()}…`;
  }

  // The reminder lands this many days before the deadline (or today, if the
  // deadline is closer than that), so there's time to buy before it.
  const CALENDAR_DAYS_BEFORE_DEADLINE = 3;

  /**
   * Google Calendar's public event-template link (no sign-in or API): an
   * all-day "buy by …" reminder 3 days before the watch's deadline, with
   * the target, the deadline, the product URL and the starting price. Every
   * value is URL-encoded.
   */
  function googleCalendarUrl(watch) {
    const deadline = parseIsoDate(watch.deadline_date);
    const today = startOfDay();
    const reminder = addDays(deadline, -CALENDAR_DAYS_BEFORE_DEADLINE);
    const day = reminder < today ? today : reminder; // never a date in the past
    const compact = (date) => toIsoDate(date).replaceAll("-", "");
    const deadlineText = formatShortDate(deadline).toLowerCase(); // "nov 13"
    const params = {
      action: "TEMPLATE",
      text: `buy by ${deadlineText}: ${shortTitle(watch.title)} — check penny`,
      // All-day events use an exclusive end date: the next day.
      dates: `${compact(day)}/${compact(addDays(day, 1))}`,
      details: [
        `target: drops ${watch.target_pct}% to ${formatMoney(watch.target_price)} or less`,
        `deadline: ${deadline.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`,
        `product: ${watch.url}`,
        `the price was ${formatMoney(watch.price_at_watch)} when you started watching.`,
      ].join("\n"),
    };
    const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
    return `https://calendar.google.com/calendar/render?${query}`;
  }

  // ---- Watched items ------------------------------------------------------
  // Opened by "see watched items" (always in the footer, on every page),
  // closed by its own "close" link.

  function openWatchlist(opener) {
    const list = $("watchlist");
    list.hidden = false;
    list.dataset.opener = opener.id;
    $("see-watched-from-footer").setAttribute("aria-expanded", "true");
    list.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    $("watchlist-close").focus({ preventScroll: true });
  }

  function closeWatchlist() {
    const list = $("watchlist");
    list.hidden = true;
    $("see-watched-from-footer").setAttribute("aria-expanded", "false");
    $(list.dataset.opener || "see-watched-from-footer")?.focus({ preventScroll: true });
  }

  function statusText(watch) {
    if (watch.notified?.drop) return "target price reached";
    if (daysBetween(new Date(), parseIsoDate(watch.deadline_date)) < 0) return "deadline passed";
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
    $("watchlist-empty").hidden = watches.length > 0;
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
    renderDevWatchOptions(watches);
  }

  // ---- Dev tools: "check price now" ---------------------------------------

  let devCheckTimer = null;

  function renderDevWatchOptions(watches) {
    const select = $("dev-watch");
    const previous = select.value;
    select.replaceChildren(
      ...watches.map((watch) => new Option(watch.title || watch.product_id, watch.product_id)),
    );
    if (watches.some((w) => w.product_id === previous)) select.value = previous;
    select.disabled = watches.length === 0;
    if (watches.length === 0) $("dev-check-status").textContent = "watch an item first.";
    renderDevCheckState();
  }

  /** Today's count against the cap, and the button's 10-minute cooldown. */
  async function renderDevCheckState() {
    const budget = await getCheckBudget();
    $("dev-check-count").textContent = `today: ${budget.count} of ${WATCH_CHECKS_PER_DAY} backend checks`;
    const lastAt = await storageGet("local", DEV_CHECK_AT_KEY, null);
    const readyAt = lastAt ? Date.parse(lastAt) + DEV_CHECK_COOLDOWN_MINUTES * 60 * 1000 : 0;
    const coolingDown = Date.now() < readyAt;
    const button = $("dev-check-now");
    button.disabled = coolingDown || budget.count >= WATCH_CHECKS_PER_DAY || $("dev-watch").options.length === 0;
    button.title = coolingDown ? `available again at ${new Date(readyAt).toLocaleTimeString()}` : "";
    clearTimeout(devCheckTimer);
    if (coolingDown) devCheckTimer = setTimeout(renderDevCheckState, readyAt - Date.now() + 500);
  }

  /** Asks the background worker for exactly one /watch-check for the selected watch. */
  async function checkPriceNow() {
    const status = $("dev-check-status");
    if (!globalThis.chrome?.runtime?.sendMessage) {
      status.textContent = "needs the installed extension (no background worker here).";
      return;
    }
    $("dev-check-now").disabled = true;
    status.textContent = "checking…";
    try {
      const result = await chrome.runtime.sendMessage({ type: "CHECK_WATCH_NOW", product_id: $("dev-watch").value });
      status.textContent = result?.ok
        ? `price ${formatMoney(result.price)} · ${result.cached ? "cached (free)" : "fresh (used credits)"} · target hit: ${result.target_hit ? "yes" : "no"}`
        : `not checked: ${result?.error ?? "no response from the background worker"}`;
    } catch (err) {
      status.textContent = `not checked: ${err.message}`;
    }
    await renderDevCheckState();
    await renderList();
  }

  // ---- Setup --------------------------------------------------------------

  async function init(options) {
    getProduct = options.getProduct;
    getGoal = options.getGoal;

    $("primary-button").addEventListener("click", onPrimaryClick);
    $("see-watched-from-footer").setAttribute("aria-expanded", "false");
    $("see-watched-from-footer").addEventListener("click", (event) => {
      if ($("watchlist").hidden) openWatchlist(event.currentTarget);
      else closeWatchlist();
    });
    $("watchlist-close").addEventListener("click", closeWatchlist);
    $("dev-check-now").addEventListener("click", checkPriceNow);

    // The background worker updates watches (last price, notified flags).
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes[WATCHES_KEY]) {
        renderList();
        refresh();
      }
      if (area === "local" && (changes[CHECK_BUDGET_KEY] || changes[DEV_CHECK_AT_KEY])) renderDevCheckState();
    });

    await renderList();
    await refresh();
  }

  return { init, refresh, setRecommendation };
})();
