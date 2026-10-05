import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace the real database module with a fake before settings.js loads.
vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../src/config/db.js';
import { getSettingValue, isSettingEnabled } from '../src/utils/settings.js';

// Makes the fake database answer with one row holding this value.
const mockRow = (value) => {
  pool.execute.mockResolvedValue([[{ setting_value: value }]]);
};

// Makes the fake database answer with no rows (setting not found).
const mockNoRows = () => {
  pool.execute.mockResolvedValue([[]]);
};

beforeEach(() => {
  pool.execute.mockReset();
});

describe('getSettingValue', () => {
  it('returns the stored value', async () => {
    mockRow('My Barangay');
    expect(await getSettingValue('site_name')).toBe('My Barangay');
  });

  it('returns the fallback when the setting is not found', async () => {
    mockNoRows();
    expect(await getSettingValue('site_name', 'Default')).toBe('Default');
  });

  it('uses an empty string as the default fallback', async () => {
    mockNoRows();
    expect(await getSettingValue('site_name')).toBe('');
  });

  it('returns the fallback when the stored value is null', async () => {
    mockRow(null);
    expect(await getSettingValue('site_name', 'Default')).toBe('Default');
  });

  it('keeps a stored empty string instead of using the fallback', async () => {
    mockRow('');
    expect(await getSettingValue('site_name', 'Default')).toBe('');
  });

  it('looks up the key with a safe parameterized query', async () => {
    mockNoRows();
    await getSettingValue('site_name');

    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('system_settings');
    expect(sql).toContain('?');
    expect(sql).not.toContain('site_name');
    expect(params).toEqual(['site_name']);
  });

  it('passes database errors to the caller', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));
    await expect(getSettingValue('site_name')).rejects.toThrow(
      'Database is down',
    );
  });
});

describe('isSettingEnabled', () => {
  it('returns true when the stored value is "true"', async () => {
    mockRow('true');
    expect(await isSettingEnabled('registration_open')).toBe(true);
  });

  it('returns false when the stored value is "false"', async () => {
    mockRow('false');
    expect(await isSettingEnabled('registration_open')).toBe(false);
  });

  it('returns false for any value other than the exact text "true"', async () => {
    for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
      mockRow(value);
      expect(await isSettingEnabled('registration_open')).toBe(false);
    }
  });

  it('defaults to enabled when the setting is not found', async () => {
    mockNoRows();
    expect(await isSettingEnabled('registration_open')).toBe(true);
  });

  it('uses a fallback of false when the setting is not found', async () => {
    mockNoRows();
    expect(await isSettingEnabled('registration_open', false)).toBe(false);
  });

  it('prefers the stored "false" over a fallback of true', async () => {
    mockRow('false');
    expect(await isSettingEnabled('registration_open', true)).toBe(false);
  });

  it('prefers the stored "true" over a fallback of false', async () => {
    mockRow('true');
    expect(await isSettingEnabled('registration_open', false)).toBe(true);
  });

  it('uses the fallback when the stored value is null', async () => {
    mockRow(null);
    expect(await isSettingEnabled('registration_open', true)).toBe(true);
    expect(await isSettingEnabled('registration_open', false)).toBe(false);
  });

  it('passes database errors to the caller', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));
    await expect(isSettingEnabled('registration_open')).rejects.toThrow(
      'Database is down',
    );
  });
});