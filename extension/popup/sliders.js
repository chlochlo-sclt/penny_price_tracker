// The two goal sliders on the recommendation card:
//   "How much do you want to save?"  → preferences.min_savings_pct (0–30)
//   "When do you need it by?"        → preferences.deadline_days   (1–90)
// The module owns the slider markup in popup.html, remembers the values in
// chrome.storage.sync, and calls the onChange handler (debounced) whenever
// the user settles on new values. It knows nothing about the backend.
const PreferenceSliders = (() => {
  const SAVINGS_MAX_PCT = 30;
  const MIN_DAYS = 1;
  const MAX_DAYS = 90;
  const DEADLINE_STOPS = [
    { days: 7, label: "1 week" },
    { days: 14, label: "2 weeks" },
    { days: 21, label: "3 weeks" },
    { days: 30, label: "1 month" },
    { days: 60, label: "2 months" },
    { days: 90, label: "3 months" },
  ];
  const DEFAULTS = { min_savings_pct: 5, deadline_days: 14 };
  const STORAGE_KEY = "preferences";
  const DEBOUNCE_MS = 300;

  let values = { ...DEFAULTS };
  let price = null;
  let currency = "USD";
  let onChange = () => {};
  let debounceTimer = null;

  const clampPct = (pct) => Math.min(SAVINGS_MAX_PCT, Math.max(0, Math.round(pct)));
  const clampDays = (days) => Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days)));

  /** Whatever came out of storage → valid values, using defaults for anything missing or broken. */
  function sanitize(stored) {
    const pct = Number(stored?.min_savings_pct);
    const days = Number(stored?.deadline_days);
    return {
      min_savings_pct: stored?.min_savings_pct != null && Number.isFinite(pct) ? clampPct(pct) : DEFAULTS.min_savings_pct,
      deadline_days: stored?.deadline_days != null && Number.isFinite(days) ? clampDays(days) : DEFAULTS.deadline_days,
    };
  }

  function nearestStopIndex(days) {
    let best = 0;
    DEADLINE_STOPS.forEach((stop, i) => {
      if (Math.abs(stop.days - days) < Math.abs(DEADLINE_STOPS[best].days - days)) best = i;
    });
    return best;
  }

  /**
   * Where `days` falls on the slider as a fraction 0–1. The stops aren't
   * evenly spaced in days (7, 14, ... 90), so interpolate between the two
   * neighbouring stops. Returns null outside the slider's range.
   */
  function sliderFraction(days) {
    const first = DEADLINE_STOPS[0].days;
    const last = DEADLINE_STOPS[DEADLINE_STOPS.length - 1].days;
    if (days < first || days > last) return null;
    for (let i = 0; i < DEADLINE_STOPS.length - 1; i++) {
      const a = DEADLINE_STOPS[i].days;
      const b = DEADLINE_STOPS[i + 1].days;
      if (days <= b) return (i + (days - a) / (b - a)) / (DEADLINE_STOPS.length - 1);
    }
    return 1;
  }

  const deadlineDate = (days) => addDays(startOfDay(), days);

  const isStop = (days) => DEADLINE_STOPS.some((s) => s.days === days);

  function deadlineLabel(days) {
    const stop = DEADLINE_STOPS.find((s) => s.days === days);
    const by = `by ${formatShortDate(deadlineDate(days))}`;
    return stop ? `${stop.label} · ${by}` : `Custom · ${by}`;
  }

  function savingsLabel(pct) {
    if (price == null) return `${pct}%`;
    return `${pct}% · ${formatMoneyShort((price * pct) / 100, currency)}`;
  }

  function renderLabels() {
    $("savings-value").textContent = savingsLabel(values.min_savings_pct);
    const deadline = deadlineLabel(values.deadline_days);
    $("deadline-value").textContent = deadline;
    $("deadline-slider").setAttribute("aria-valuetext", deadline);
    $("deadline-date-input").value = toIsoDate(deadlineDate(values.deadline_days));
    // A picked date between stops can't be shown by the thumb (it sits on
    // the nearest stop), so dim the slider and keep the date field visible.
    const custom = !isStop(values.deadline_days);
    $("deadline-slider").classList.toggle("preference-slider--inactive", custom);
    if (custom) $("deadline-date-input").hidden = false;
  }

  // A small "Black Friday" tag above the deadline slider, if it's in range.
  function renderBlackFriday() {
    const marker = $("black-friday-marker");
    const blackFriday = nextBlackFriday();
    const fraction = blackFriday ? sliderFraction(daysBetween(new Date(), blackFriday)) : null;
    marker.hidden = fraction == null;
    if (fraction == null) return;
    marker.title = `Black Friday · ${formatShortDate(blackFriday)}`;
    // The one style value computed in JS: popup.css positions the marker
    // from this custom property.
    marker.style.setProperty("--marker-position", fraction);
  }

  function save() {
    storageSet("sync", STORAGE_KEY, values);
  }

  /** Called on every movement: update labels now, notify the handler once things settle. */
  function changed() {
    renderLabels();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      save();
      onChange({ ...values });
    }, DEBOUNCE_MS);
  }

  async function init(handler) {
    onChange = handler;
    values = sanitize(await storageGet("sync", STORAGE_KEY, null));

    const savingsSlider = $("savings-slider");
    const deadlineSlider = $("deadline-slider");
    const dateInput = $("deadline-date-input");

    savingsSlider.max = SAVINGS_MAX_PCT;
    savingsSlider.value = values.min_savings_pct;
    deadlineSlider.max = DEADLINE_STOPS.length - 1;
    deadlineSlider.value = nearestStopIndex(values.deadline_days);
    dateInput.min = toIsoDate(deadlineDate(MIN_DAYS));
    dateInput.max = toIsoDate(deadlineDate(MAX_DAYS));

    savingsSlider.addEventListener("input", () => {
      values.min_savings_pct = clampPct(Number(savingsSlider.value));
      changed();
    });
    deadlineSlider.addEventListener("input", () => {
      values.deadline_days = DEADLINE_STOPS[Number(deadlineSlider.value)].days;
      changed();
    });
    // "change" fires when the user lets go; save right away in case the
    // popup closes before the debounce timer runs.
    savingsSlider.addEventListener("change", save);
    deadlineSlider.addEventListener("change", save);

    $("pick-date-button").addEventListener("click", () => {
      dateInput.hidden = false;
      dateInput.focus();
      dateInput.showPicker?.();
    });
    dateInput.addEventListener("change", () => {
      if (!dateInput.value) return;
      values.deadline_days = clampDays(daysBetween(new Date(), parseIsoDate(dateInput.value)));
      deadlineSlider.value = nearestStopIndex(values.deadline_days);
      changed();
    });

    renderLabels();
    renderBlackFriday();
  }

  /** The slider's dollar amounts are based on the detected product's price. */
  function setPrice(newPrice, newCurrency = "USD") {
    price = newPrice;
    currency = newCurrency;
    renderLabels();
  }

  return { init, setPrice, getValues: () => ({ ...values }), DEFAULTS };
})();
