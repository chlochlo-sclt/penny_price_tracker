// Date helpers shared by the side panel and background worker. Everything works
// in the user's local time zone at day granularity: a deadline of
// "2026-11-27" means the end of Nov 27 where the user is.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Local midnight of the given moment (default: now). */
function startOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Whole days from `from` to `to`, both rounded to local midnight. */
function daysBetween(from, to) {
  // Math.round absorbs the 23/25-hour days around daylight-saving changes.
  return Math.round((startOfDay(to) - startOfDay(from)) / MS_PER_DAY);
}

/** Date → "2026-11-27" in local time (toISOString would use UTC). */
function toIsoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "2026-11-27" → local midnight of that day. */
function parseIsoDate(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Date → "Nov 27" */
function formatShortDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The next month/day (month is 1–12) on or after `from`, e.g. Oct 31 → next Halloween. */
function nextOccurrence(month, day, from = new Date()) {
  const today = startOfDay(from);
  const thisYear = new Date(today.getFullYear(), month - 1, day);
  return thisYear >= today ? thisYear : new Date(today.getFullYear() + 1, month - 1, day);
}

/**
 * The next occurrence of each holiday the deadline slider marks, soonest
 * first: [{ id, name, date }]. Works for any year.
 */
function upcomingHolidays(from = new Date()) {
  return [
    { id: "halloween", name: "Halloween", date: nextOccurrence(10, 31, from) },
    { id: "black-friday", name: "Black Friday", date: nextBlackFriday(from) },
    { id: "christmas", name: "Christmas", date: nextOccurrence(12, 25, from) },
    { id: "new-year", name: "New Year's Day", date: nextOccurrence(1, 1, from) },
  ].sort((a, b) => a.date - b.date);
}

/** The next Black Friday on or after `from`: the day after the 4th Thursday of November. */
function nextBlackFriday(from = new Date()) {
  const today = startOfDay(from);
  for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
    const nov1 = new Date(year, 10, 1);
    const firstThursday = 1 + ((4 - nov1.getDay() + 7) % 7);
    const blackFriday = new Date(year, 10, firstThursday + 21 + 1);
    if (blackFriday >= today) return blackFriday;
  }
  return null;
}
