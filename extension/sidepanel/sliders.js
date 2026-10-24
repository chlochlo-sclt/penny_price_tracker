// The two goal sliders on the recommendation card:
//   "How much do you want to save?"  → preferences.min_savings_pct (0–30)
//   "When do you need it by?"        → preferences.deadline_days   (1–90)
// The module owns the slider markup in sidepanel.html, remembers the values in
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

  // Shown on the deadline slider when they fall inside its 1–90 day range.
  const HOLIDAY_ICONS = { halloween: "🎃", "black-friday": "🛍️", christmas: "🎄", "new-year": "🎉" };

  /** Holidays inside the slider's range: [{ id, name, date, days, fraction }]. */
  function holidaysInRange() {
    return upcomingHolidays()
      .map((h) => ({ ...h, days: daysBetween(new Date(), h.date) }))
      .map((h) => ({ ...h, fraction: h.days >= MIN_DAYS && h.days <= MAX_DAYS ? sliderFraction(h.days) : null }))
      .filter((h) => h.fraction != null);
  }

  function deadlineLabel(days) {
    const stop = DEADLINE_STOPS.find((s) => s.days === days);
    const by = `by ${formatShortDate(deadlineDate(days))}`;
    const holiday = holidaysInRange().find((h) => h.days === days);
    const label = stop ? `${stop.label} · ${by}` : `Custom · ${by}`;
    return holiday ? `${label} · ${holiday.name}` : label;
  }

  function savingsLabel(pct) {
    if (price == null) return `${pct}%`;
    return `${pct}% · ${formatMoneyShort((price * pct) / 100, currency)}`;
  }

  /** How far along its track a slider's thumb is (0–1), for the CSS fill. */
  function setFill(slider) {
    const fraction = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    slider.style.setProperty("--fill-fraction", fraction.toFixed(4));
  }

  function renderLabels() {
    $("savings-value").textContent = savingsLabel(values.min_savings_pct);
    setFill($("savings-slider"));
    // Colors: copper → silver → gold for savings; the deadline date's season
    // for the whole panel (mesh background, date slider, small accents).
    // theme.js picks the palettes; sidepanel.css has the colors.
    SliderTheme.applyCoin($("savings-control"), values.min_savings_pct);
    SliderTheme.applySeason(document.documentElement, deadlineDate(values.deadline_days));
    const deadline = deadlineLabel(values.deadline_days);
    $("deadline-value").textContent = deadline;
    $("deadline-slider").setAttribute("aria-valuetext", deadline);
    $("deadline-date-input").value = toIsoDate(deadlineDate(values.deadline_days));
    // A picked date between stops can't be shown by the native thumb (it
    // only sits on stops), so draw a stand-in thumb at the date's true
    // position, run the fill to it, and keep the date field visible.
    const deadlineSlider = $("deadline-slider");
    const custom = !isStop(values.deadline_days);
    const fraction = sliderFraction(values.deadline_days);
    deadlineSlider.classList.toggle("preference-slider--custom", custom);
    deadlineSlider.style.setProperty("--fill-fraction", fraction.toFixed(4));
    const customThumb = $("deadline-custom-thumb");
    customThumb.hidden = !custom;
    customThumb.style.setProperty("--marker-position", fraction.toFixed(4));
    if (custom) $("deadline-date-input").hidden = false;
  }

  /**
   * Small holiday markers above the deadline slider. Each is a button that
   * sets the deadline to that day. Markers closer than ~7% of the track are
   * staggered vertically so they don't overlap (e.g. Christmas and New Year).
   */
  function renderHolidayMarkers() {
    const container = $("holiday-markers");
    let previous = null;
    let raised = false;
    container.replaceChildren(
      ...holidaysInRange().map((holiday) => {
        const marker = document.createElement("button");
        marker.type = "button";
        marker.className = `deadline-slider-marker deadline-slider-marker--${holiday.id}`;
        raised = previous != null && holiday.fraction - previous < 0.07 ? !raised : false;
        marker.classList.toggle("deadline-slider-marker--raised", raised);
        previous = holiday.fraction;
        const label = `${holiday.name} · ${formatShortDate(holiday.date)}`;
        marker.title = label;
        marker.setAttribute("aria-label", `Set deadline to ${label}`);
        marker.textContent = HOLIDAY_ICONS[holiday.id];
        // Position is the one layout value computed in JS; sidepanel.css uses it.
        marker.style.setProperty("--marker-position", holiday.fraction.toFixed(4));
        marker.addEventListener("click", () => setDeadlineDays(holiday.days));
        return marker;
      }),
    );
  }

  function setDeadlineDays(days) {
    values.deadline_days = clampDays(days);
    $("deadline-slider").value = nearestStopIndex(values.deadline_days);
    changed();
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
    // panel closes before the debounce timer runs.
    savingsSlider.addEventListener("change", save);
    deadlineSlider.addEventListener("change", save);

    $("pick-date-button").addEventListener("click", () => {
      dateInput.hidden = false;
      dateInput.focus();
      dateInput.showPicker?.();
    });
    dateInput.addEventListener("change", () => {
      if (!dateInput.value) return;
      setDeadlineDays(daysBetween(new Date(), parseIsoDate(dateInput.value)));
    });

    renderLabels();
    renderHolidayMarkers();
  }

  /** The slider's dollar amounts are based on the detected product's price. */
  function setPrice(newPrice, newCurrency = "USD") {
    price = newPrice;
    currency = newCurrency;
    renderLabels();
  }

  return { init, setPrice, getValues: () => ({ ...values }), DEFAULTS };
})();
