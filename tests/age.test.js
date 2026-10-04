import { describe, it, expect } from 'vitest';
import {
  toDateOnlyString,
  getAgeBreakdown,
  calculateAge,
  formatPreciseAge,
} from '../src/utils/age.js';

// Fixed "today" so the tests give the same result on any day (June 15, 2026, local time).
const NOW = new Date(2026, 5, 15);

describe('toDateOnlyString', () => {
  it('returns null for null', () => {
    expect(toDateOnlyString(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(toDateOnlyString(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(toDateOnlyString('')).toBeNull();
  });

  it('formats a Date as YYYY-MM-DD with zero padding', () => {
    expect(toDateOnlyString(new Date(2000, 0, 5))).toBe('2000-01-05');
  });

  it('returns null for an invalid Date', () => {
    expect(toDateOnlyString(new Date('invalid'))).toBeNull();
  });

  it('keeps only the first 10 characters of a string', () => {
    expect(toDateOnlyString('2000-01-05T10:00:00.000Z')).toBe('2000-01-05');
  });
});

describe('getAgeBreakdown', () => {
  it('returns exact years on the birthday', () => {
    expect(getAgeBreakdown('2000-06-15', NOW)).toEqual({
      years: 26,
      months: 0,
      weeks: 0,
      days: 0,
    });
  });

  it('is one day short of the next year the day before the birthday', () => {
    expect(getAgeBreakdown('2000-06-16', NOW)).toEqual({
      years: 25,
      months: 11,
      weeks: 4,
      days: 2,
    });
  });

  it('breaks down years, months, weeks, and days', () => {
    expect(getAgeBreakdown('2001-02-28', NOW)).toEqual({
      years: 25,
      months: 3,
      weeks: 2,
      days: 4,
    });
  });

  it('handles month-end birthdays in shorter months', () => {
    // Jan 31 -> Mar 1, 2026: anchors on Feb 28, so 1 month and 1 day
    expect(getAgeBreakdown('2000-01-31', new Date(2026, 2, 1))).toEqual({
      years: 26,
      months: 1,
      weeks: 0,
      days: 1,
    });
  });

  it('returns all zeros for someone born today', () => {
    expect(getAgeBreakdown('2026-06-15', NOW)).toEqual({
      years: 0,
      months: 0,
      weeks: 0,
      days: 0,
    });
  });

  it('returns 1 day for someone born yesterday', () => {
    expect(getAgeBreakdown('2026-06-14', NOW)).toEqual({
      years: 0,
      months: 0,
      weeks: 0,
      days: 1,
    });
  });

  it('accepts a Date object as the birthdate', () => {
    expect(getAgeBreakdown(new Date(2000, 5, 15), NOW).years).toBe(26);
  });

  it('returns null for a birthdate in the future', () => {
    expect(getAgeBreakdown('2030-01-01', NOW)).toBeNull();
  });

  it('returns null for text that is not a date', () => {
    expect(getAgeBreakdown('not-a-date', NOW)).toBeNull();
  });

  it('returns null for dates that do not exist', () => {
    expect(getAgeBreakdown('2000-02-30', NOW)).toBeNull();
    expect(getAgeBreakdown('2001-02-29', NOW)).toBeNull();
    expect(getAgeBreakdown('2000-13-01', NOW)).toBeNull();
  });

  it('returns null for missing values', () => {
    expect(getAgeBreakdown(null, NOW)).toBeNull();
    expect(getAgeBreakdown(undefined, NOW)).toBeNull();
    expect(getAgeBreakdown('', NOW)).toBeNull();
  });
});

describe('calculateAge', () => {
  it('counts the new year on the birthday itself', () => {
    expect(calculateAge('2000-06-15', NOW)).toBe(26);
  });

  it('has not counted the new year the day before the birthday', () => {
    expect(calculateAge('2000-06-16', NOW)).toBe(25);
  });

  it('counts the new year after the birthday has passed', () => {
    expect(calculateAge('2000-06-14', NOW)).toBe(26);
  });

  it('returns 0 for a baby under one year old', () => {
    expect(calculateAge('2026-01-01', NOW)).toBe(0);
  });

  it('returns null for a future birthdate', () => {
    expect(calculateAge('2030-01-01', NOW)).toBeNull();
  });

  it('returns null for an invalid birthdate', () => {
    expect(calculateAge('garbage', NOW)).toBeNull();
  });

  it('returns null for a missing birthdate', () => {
    expect(calculateAge(null, NOW)).toBeNull();
  });
});

describe('formatPreciseAge', () => {
  it('formats years, months, weeks, and days', () => {
    expect(formatPreciseAge('2001-02-28', NOW)).toBe(
      '25 years, 3 months, 2 weeks, 4 days',
    );
  });

  it('omits units that are zero', () => {
    expect(formatPreciseAge('2000-06-15', NOW)).toBe('26 years');
    expect(formatPreciseAge('2026-04-10', NOW)).toBe('2 months, 5 days');
  });

  it('uses singular words for a value of 1', () => {
    expect(formatPreciseAge('2025-05-07', NOW)).toBe(
      '1 year, 1 month, 1 week, 1 day',
    );
  });

  it('uses plural words for values above 1', () => {
    expect(formatPreciseAge('2024-06-15', NOW)).toBe('2 years');
  });

  it('says "1 day" for someone born yesterday', () => {
    expect(formatPreciseAge('2026-06-14', NOW)).toBe('1 day');
  });

  it('says "0 days" for someone born today', () => {
    expect(formatPreciseAge('2026-06-15', NOW)).toBe('0 days');
  });

  it('returns an empty string for an invalid birthdate', () => {
    expect(formatPreciseAge('garbage', NOW)).toBe('');
  });

  it('returns an empty string for a future birthdate', () => {
    expect(formatPreciseAge('2030-01-01', NOW)).toBe('');
  });
});