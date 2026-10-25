// The three goal sliders on the recommendation card:
//   "when do you want it by?"        → preferences.deadline_days      (1–90, any day)
//   "how much do you want to save?"  → preferences.min_savings_pct    (1–30)
//   "how sure do you want to be?"    → preferences.min_confidence_pct (50–95)
// The module owns the slider markup in sidepanel.html, remembers the values in
// chrome.storage.sync, and calls the onChange handler (debounced) whenever
// the user settles on new values. It knows nothing about the backend.
const PreferenceSliders = (() => {
  // The backend accepts 1–50 (Preferences.min_savings_pct in app/schemas.py).
  const SAVINGS_MIN_PCT = 1;
  const SAVINGS_MAX_PCT = 30;
  const MIN_DAYS = 1;
  const MAX_DAYS = 90;
  // A holiday badge shows when the deadline is this close to the holiday.
  const HOLIDAY_BADGE_WINDOW_DAYS = 2;
  // The schema only accepts 50–95 (Preferences.min_confidence_pct), so the
  // slider is limited to that; MIN_CONFIDENCE_RANGE lives in api.js.
  const CONFIDENCE_MIN_PCT = MIN_CONFIDENCE_RANGE.min;
  const CONFIDENCE_MAX_PCT = MIN_CONFIDENCE_RANGE.max;
  // The confidence slider's words, fitted to its 50–95 range. Change the
  // cutoffs here: each level covers values up to and including `upTo`.
  const CONFIDENCE_LEVELS = [
    { upTo: 64, label: "low" },
    { upTo: 79, label: "medium" },
    { upTo: 100, label: "high" },
  ];
  const DEFAULTS = { min_savings_pct: 5, deadline_days: 14, min_confidence_pct: DEFAULT_MIN_CONFIDENCE_PCT };
  const STORAGE_KEY = "preferences";
  const DEBOUNCE_MS = 300;

  let values = { ...DEFAULTS };
  let price = null;
  let currency = "USD";
  let onChange = () => {};
  let debounceTimer = null;

  const clampPct = (pct) => Math.min(SAVINGS_MAX_PCT, Math.max(SAVINGS_MIN_PCT, Math.round(pct)));
  const clampDays = (days) => Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days)));
  const clampConfidence = (pct) => Math.min(CONFIDENCE_MAX_PCT, Math.max(CONFIDENCE_MIN_PCT, Math.round(pct)));

  /** Whatever came out of storage → valid values, using defaults for anything missing or broken. */
  function sanitize(stored) {
    const pct = Number(stored?.min_savings_pct);
    const days = Number(stored?.deadline_days);
    const confidence = Number(stored?.min_confidence_pct);
    return {
      min_savings_pct: stored?.min_savings_pct != null && Number.isFinite(pct) ? clampPct(pct) : DEFAULTS.min_savings_pct,
      deadline_days: stored?.deadline_days != null && Number.isFinite(days) ? clampDays(days) : DEFAULTS.deadline_days,
      min_confidence_pct: stored?.min_confidence_pct != null && Number.isFinite(confidence) ? clampConfidence(confidence) : DEFAULTS.min_confidence_pct,
    };
  }

  const deadlineDate = (days) => addDays(startOfDay(), days);

  /** The holiday within a couple of days of `date`, if any (shared/dates.js). */
  function holidayNear(date) {
    return upcomingHolidays().find((h) => Math.abs(daysBetween(date, h.date)) <= HOLIDAY_BADGE_WINDOW_DAYS) ?? null;
  }

  /** "by Nov 27 · Black Friday" (shown lowercase by the CSS). */
  function deadlineLabel(days) {
    const date = deadlineDate(days);
    const holiday = holidayNear(date);
    const by = `by ${formatShortDate(date)}`;
    return holiday ? `${by} · ${holiday.name}` : by;
  }

  /** "65% · medium", using the cutoffs in CONFIDENCE_LEVELS. */
  function confidenceLabel(pct) {
    const level = CONFIDENCE_LEVELS.find((l) => pct <= l.upTo) ?? CONFIDENCE_LEVELS.at(-1);
    return `${pct}% · ${level.label}`;
  }

  /** "$115 · 10%" */
  function savingsLabel(pct) {
    if (price == null) return `${pct}%`;
    return `${formatMoneyShort((price * pct) / 100, currency)} · ${pct}%`;
  }

  /** How far along its track a slider's thumb is (0–1), for the CSS fill. */
  function setFill(slider) {
    const fraction = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    slider.style.setProperty("--fill-fraction", fraction.toFixed(4));
  }

  function renderLabels() {
    const savingsSlider = $("savings-slider");
    const deadlineSlider = $("deadline-slider");
    const confidenceSlider = $("confidence-slider");
    savingsSlider.value = values.min_savings_pct;
    deadlineSlider.value = values.deadline_days;
    confidenceSlider.value = values.min_confidence_pct;
    setFill(savingsSlider);
    setFill(deadlineSlider);
    setFill(confidenceSlider);
    $("confidence-value").textContent = confidenceLabel(values.min_confidence_pct);

    $("savings-value").textContent = savingsLabel(values.min_savings_pct);
    const deadline = deadlineLabel(values.deadline_days);
    $("deadline-value").textContent = deadline;
    deadlineSlider.setAttribute("aria-valuetext", `${values.deadline_days} days, ${deadline}`);

    // Colors: copper → silver → gold for savings; the deadline date's season
    // for the whole panel (mesh background, date slider, dark December).
    // theme.js picks the palettes; sidepanel.css has the colors.
    SliderTheme.applyCoin($("savings-control"), values.min_savings_pct);
    SliderTheme.applySeason(document.documentElement, deadlineDate(values.deadline_days));
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
    const confidenceSlider = $("confidence-slider");
    savingsSlider.min = SAVINGS_MIN_PCT;
    savingsSlider.max = SAVINGS_MAX_PCT;
    deadlineSlider.min = MIN_DAYS;
    deadlineSlider.max = MAX_DAYS;
    confidenceSlider.min = CONFIDENCE_MIN_PCT;
    confidenceSlider.max = CONFIDENCE_MAX_PCT;
    $("confidence-min-tick").textContent = `${CONFIDENCE_MIN_PCT}%`;
    $("confidence-max-tick").textContent = `${CONFIDENCE_MAX_PCT}%`;

    savingsSlider.addEventListener("input", () => {
      values.min_savings_pct = clampPct(Number(savingsSlider.value));
      changed();
    });
    deadlineSlider.addEventListener("input", () => {
      values.deadline_days = clampDays(Number(deadlineSlider.value));
      changed();
    });
    confidenceSlider.addEventListener("input", () => {
      values.min_confidence_pct = clampConfidence(Number(confidenceSlider.value));
      changed();
    });
    // "change" fires when the user lets go; save right away in case the
    // panel closes before the debounce timer runs.
    savingsSlider.addEventListener("change", save);
    deadlineSlider.addEventListener("change", save);
    confidenceSlider.addEventListener("change", save);

    renderLabels();
  }

  /** The slider's dollar amounts are based on the detected product's price. */
  function setPrice(newPrice, newCurrency = "USD") {
    price = newPrice;
    currency = newCurrency;
    renderLabels();
  }

  return { init, setPrice, getValues: () => ({ ...values }), DEFAULTS };
})();
