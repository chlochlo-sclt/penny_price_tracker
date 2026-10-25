// Seasonal and coin colors: the season of the deadline date sets the whole
// panel's palette (mesh background blobs, base color, date slider fill), and
// the savings slider shifts copper → silver → gold as the goal grows.
//
// No colors live here. Each season is a set of CSS custom properties in
// sidepanel.css: --season-<name>-1/-2/-3 (the three blobs) and
// --season-<name>-base (the light background), and each coin is
// --coin-<name>-1/-2. This file only decides WHICH two palettes to blend and
// HOW FAR, and sets on the element:
//   --<prefix>-from-<n>, --<prefix>-to-<n>   var() references to two palettes
//   --<prefix>-mix                           0%–100% of the way from → to
// sidepanel.css mixes them with color-mix(); the results are registered with
// @property, so they animate.
//
// December is dark (data-theme="dark" on <html>). That switch is discrete,
// not blended: a half-dark background would leave text on mid-gray, which
// has poor contrast in both themes.
const SliderTheme = (() => {
  // Anchor dates, in calendar order. Between two anchors the colors blend
  // linearly; two anchors with the same palette hold it steady between them.
  const SEASON_ANCHORS = [
    { month: 1, day: 1, palette: "new-year" },
    { month: 1, day: 15, palette: "new-year" },
    { month: 2, day: 12, palette: "late-winter" },
    { month: 3, day: 8, palette: "late-winter-pink" },
    { month: 4, day: 10, palette: "spring" },
    { month: 5, day: 20, palette: "spring" },
    { month: 7, day: 1, palette: "summer" },
    { month: 8, day: 20, palette: "summer" },
    { month: 9, day: 15, palette: "early-fall" },
    { month: 10, day: 12, palette: "early-fall" },
    { month: 10, day: 25, palette: "halloween" },
    { month: 10, day: 31, palette: "halloween" },
    { month: 11, day: 10, palette: "november" },
    { month: 11, day: 30, palette: "november" },
    { month: 12, day: 12, palette: "winter" },
    { month: 12, day: 22, palette: "christmas" },
    { month: 12, day: 26, palette: "christmas" },
    { month: 12, day: 30, palette: "new-year" },
  ];

  const SEASON_COLORS = ["1", "2", "3", "base"];

  /** Dark, high-contrast theme for deadlines in December. */
  const isDarkSeason = (date) => date.getMonth() === 11;

  // Savings slider stops, by percent.
  const COIN_STOPS = [
    { at: 0, palette: "copper" },
    { at: 15, palette: "silver" },
    { at: 30, palette: "gold" },
  ];

  /** Finds the two stops around `value` and how far between them it is. */
  function between(stops, value) {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (value <= b.at) {
        const t = b.at === a.at ? 0 : (value - a.at) / (b.at - a.at);
        return { from: a.palette, to: b.palette, t: Math.min(1, Math.max(0, t)) };
      }
    }
    const last = stops[stops.length - 1];
    return { from: last.palette, to: last.palette, t: 0 };
  }

  /** Season blend for a date. Anchors wrap around the year end. */
  function seasonFor(date) {
    const year = date.getFullYear();
    const at = (y, a) => new Date(y, a.month - 1, a.day).getTime();
    const first = SEASON_ANCHORS[0];
    const last = SEASON_ANCHORS[SEASON_ANCHORS.length - 1];
    const stops = [
      { at: at(year - 1, last), palette: last.palette },
      ...SEASON_ANCHORS.map((a) => ({ at: at(year, a), palette: a.palette })),
      { at: at(year + 1, first), palette: first.palette },
    ];
    return between(stops, startOfDay(date).getTime());
  }

  const coinFor = (savingsPct) => between(COIN_STOPS, savingsPct);

  /** Points the element's --<prefix>-from/to/mix properties at a blend. */
  function apply(el, prefix, { from, to, t }, colors) {
    for (const n of colors) {
      el.style.setProperty(`--${prefix}-from-${n}`, `var(--${prefix}-${from}-${n})`);
      el.style.setProperty(`--${prefix}-to-${n}`, `var(--${prefix}-${to}-${n})`);
    }
    el.style.setProperty(`--${prefix}-mix`, `${(t * 100).toFixed(1)}%`);
    el.dataset[prefix] = t < 0.5 ? from : to; // e.g. data-season="halloween", handy for debugging
  }

  return {
    applySeason(el, date) {
      apply(el, "season", seasonFor(date), SEASON_COLORS);
      el.dataset.theme = isDarkSeason(date) ? "dark" : "light";
    },
    applyCoin: (el, savingsPct) => apply(el, "coin", coinFor(savingsPct), ["1", "2"]),
  };
})();
