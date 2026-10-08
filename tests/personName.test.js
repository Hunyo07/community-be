import { describe, it, expect } from 'vitest';
import { assertEmail, assertPersonName, personNameMessage } from '../src/utils/personName.js';
import { isBarangayAdmin, isCityWideAdmin, isOperationallyScoped, managesSingleBarangay } from '../src/utils/barangayScope.js';

describe('assertPersonName', () => {
  it('allows letters, spaces, hyphens, apostrophes, and periods', () => {
    expect(assertPersonName("Mary-Jane O'Brien Jr.", 'Name')).toBe("Mary-Jane O'Brien Jr.");
    expect(assertPersonName('Niña', 'Name')).toBe('Niña');
  });

  it('rejects digits and symbols', () => {
    expect(() => assertPersonName('Juan@', 'First name')).toThrow(personNameMessage('First name'));
    expect(() => assertPersonName('Juan2', 'First name')).toThrow(/First name/);
  });

  it('rejects a required name that is only spaces', () => {
    expect(() => assertPersonName('   ', 'First name')).toThrow('First name is required');
  });
});

describe('assertEmail', () => {
  it('rejects a malformed email', () => {
    expect(() => assertEmail('not-an-email')).toThrow('Email is not a valid email address.');
  });
});

describe('barangay scope', () => {
  it('treats an admin with no barangay as city-wide', () => {
    const user = { role: 'admin', barangay: null };
    expect(isCityWideAdmin(user)).toBe(true);
    expect(isBarangayAdmin(user)).toBe(false);
    expect(isOperationallyScoped(user)).toBe(false);
    expect(managesSingleBarangay(user)).toBe(false);
  });

  it('scopes an admin to the barangay on their account', () => {
    const user = { role: 'admin', barangay: 'Atioc', permissions: ['residents:view_all'] };
    expect(isCityWideAdmin(user)).toBe(false);
    expect(isBarangayAdmin(user)).toBe(true);
    expect(isOperationallyScoped(user)).toBe(true);
    expect(managesSingleBarangay(user)).toBe(true);
  });

  it('still lets barangay staff with view-all see every resident barangay', () => {
    const user = { role: 'barangay_staff', barangay: 'Balanti', permissions: ['residents:view_all'] };
    expect(isOperationallyScoped(user)).toBe(false);
    expect(managesSingleBarangay(user)).toBe(true);
  });
});
