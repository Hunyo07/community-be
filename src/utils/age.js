// Age helpers that derive a resident's age from a YYYY-MM-DD birthdate and today's date.

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (value) => String(value).padStart(2, "0");

// mysql2 returns DATE columns as local-midnight Date objects, so read local parts, not UTC.
export const toDateOnlyString = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
};

// Parses a YYYY-MM-DD string (or Date) into a UTC midnight timestamp, or null when invalid.
const toUtcDay = (value) => {
  const text = toDateOnlyString(value) || "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return time;
};

const todayUtc = (now = new Date()) =>
  Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

// Breaks the time since birth into whole years, months, weeks, and days.
export const getAgeBreakdown = (birthDate, now = new Date()) => {
  const birth = toUtcDay(birthDate);
  if (birth === null) return null;
  const today = todayUtc(now);
  if (birth > today) return null;

  const start = new Date(birth);
  const end = new Date(today);
  let totalMonths =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) totalMonths -= 1;

  // Month-end birthdays (e.g. Jan 31) anchor on the last day of shorter months.
  const anchorYear =
    start.getUTCFullYear() + Math.floor((start.getUTCMonth() + totalMonths) / 12);
  const anchorMonth = (start.getUTCMonth() + totalMonths) % 12;
  const lastDayOfAnchorMonth = new Date(
    Date.UTC(anchorYear, anchorMonth + 1, 0),
  ).getUTCDate();
  const anchor = Date.UTC(
    anchorYear,
    anchorMonth,
    Math.min(start.getUTCDate(), lastDayOfAnchorMonth),
  );
  const remainingDays = Math.round((today - anchor) / DAY_MS);

  return {
    years: Math.floor(totalMonths / 12),
    months: totalMonths % 12,
    weeks: Math.floor(remainingDays / 7),
    days: remainingDays % 7,
  };
};

// Whole-year age, or null when the birthdate is missing, invalid, or in the future.
export const calculateAge = (birthDate, now = new Date()) =>
  getAgeBreakdown(birthDate, now)?.years ?? null;

const plural = (value, unit) => `${value} ${unit}${value === 1 ? "" : "s"}`;

// Formats an age like "25 years, 3 months, 2 weeks, 4 days", omitting zero units.
export const formatPreciseAge = (birthDate, now = new Date()) => {
  const age = getAgeBreakdown(birthDate, now);
  if (!age) return "";

  const parts = [
    age.years && plural(age.years, "year"),
    age.months && plural(age.months, "month"),
    age.weeks && plural(age.weeks, "week"),
    age.days && plural(age.days, "day"),
  ].filter(Boolean);

  return parts.length ? parts.join(", ") : "0 days";
};
