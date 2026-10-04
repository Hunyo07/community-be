import { describe, it, expect } from 'vitest';
import {
  RESIDENT_GENDERS,
  RESIDENT_CIVIL_STATUSES,
  RESIDENT_HOUSEHOLD_STATUSES,
  RESIDENT_CITY,
  formatResidentAddress,
  formatBeneficiaryStatus,
  normalizeResidentProfileFields,
} from '../src/utils/residentProfile.js';

// Runs a function and returns the error it throws (or null if it does not throw).
const getError = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

describe('allowed values', () => {
  it('has the expected gender choices', () => {
    expect(RESIDENT_GENDERS).toEqual(['Female', 'Male', 'Unspecified']);
  });

  it('allows Unspecified in every list', () => {
    expect(RESIDENT_GENDERS).toContain('Unspecified');
    expect(RESIDENT_CIVIL_STATUSES).toContain('Unspecified');
    expect(RESIDENT_HOUSEHOLD_STATUSES).toContain('Unspecified');
  });

  it('uses Tarlac City as the city', () => {
    expect(RESIDENT_CITY).toBe('Tarlac City');
  });
});

describe('formatResidentAddress', () => {
  it('joins street, purok, barangay, and city', () => {
    expect(
      formatResidentAddress({
        streetAddress: '123 Rizal St',
        purokSitio: 'Purok 5',
        barangay: 'San Nicolas',
      }),
    ).toBe('123 Rizal St, Purok 5, Brgy. San Nicolas, Tarlac City');
  });

  it('skips a missing street', () => {
    expect(
      formatResidentAddress({
        purokSitio: 'Purok 5',
        barangay: 'San Nicolas',
      }),
    ).toBe('Purok 5, Brgy. San Nicolas, Tarlac City');
  });

  it('works with only a barangay', () => {
    expect(formatResidentAddress({ barangay: 'San Nicolas' })).toBe(
      'Brgy. San Nicolas, Tarlac City',
    );
  });

  it('leaves out Brgy. and the city when there is no barangay', () => {
    expect(
      formatResidentAddress({
        streetAddress: '123 Rizal St',
        purokSitio: 'Purok 5',
      }),
    ).toBe('123 Rizal St, Purok 5');
  });

  it('returns an empty string when everything is missing', () => {
    expect(formatResidentAddress({})).toBe('');
  });

  it('treats null values as missing', () => {
    expect(
      formatResidentAddress({
        streetAddress: null,
        purokSitio: null,
        barangay: null,
      }),
    ).toBe('');
  });

  it('trims spaces and skips blank parts', () => {
    expect(
      formatResidentAddress({
        streetAddress: '  123 Rizal St  ',
        purokSitio: '   ',
        barangay: 'San Nicolas',
      }),
    ).toBe('123 Rizal St, Brgy. San Nicolas, Tarlac City');
  });
});

describe('formatBeneficiaryStatus', () => {
  it('says not a beneficiary for 0 programs', () => {
    expect(formatBeneficiaryStatus(0)).toBe('Not a beneficiary');
  });

  it('says not a beneficiary when the count is missing', () => {
    expect(formatBeneficiaryStatus(null)).toBe('Not a beneficiary');
    expect(formatBeneficiaryStatus(undefined)).toBe('Not a beneficiary');
  });

  it('says not a beneficiary for a negative count', () => {
    expect(formatBeneficiaryStatus(-1)).toBe('Not a beneficiary');
  });

  it('uses the singular word for 1 program', () => {
    expect(formatBeneficiaryStatus(1)).toBe('Beneficiary (1 program)');
  });

  it('uses the plural word for several programs', () => {
    expect(formatBeneficiaryStatus(2)).toBe('Beneficiary (2 programs)');
  });

  it('accepts a count written as text', () => {
    expect(formatBeneficiaryStatus('3')).toBe('Beneficiary (3 programs)');
  });
});

describe('normalizeResidentProfileFields', () => {
  it('fills in defaults when nothing is given', () => {
    expect(normalizeResidentProfileFields({})).toEqual({
      gender: 'Unspecified',
      civilStatus: 'Unspecified',
      nationality: null,
      householdStatus: 'Unspecified',
      contactNumber: '',
      purokSitio: '',
      streetAddress: '',
    });
  });

  it('accepts a complete valid profile', () => {
    const body = {
      gender: 'Female',
      civilStatus: 'Married',
      nationality: 'Filipino',
      householdStatus: 'Household Head',
      contactNumber: '0917 123 4567',
      purokSitio: 'Purok 5',
      streetAddress: '123 Rizal St',
    };
    expect(normalizeResidentProfileFields(body)).toEqual(body);
  });

  it('trims spaces around values', () => {
    expect(
      normalizeResidentProfileFields({
        gender: '  Male  ',
        civilStatus: ' Single ',
        householdStatus: ' Household Member ',
        nationality: ' Filipino ',
        purokSitio: ' Purok 5 ',
        streetAddress: ' 123 Rizal St ',
      }),
    ).toEqual({
      gender: 'Male',
      civilStatus: 'Single',
      nationality: 'Filipino',
      householdStatus: 'Household Member',
      contactNumber: '',
      purokSitio: 'Purok 5',
      streetAddress: '123 Rizal St',
    });
  });

  it('uses Unspecified for blank or null choices', () => {
    const result = normalizeResidentProfileFields({
      gender: '',
      civilStatus: null,
      householdStatus: '   ',
    });
    expect(result.gender).toBe('Unspecified');
    expect(result.civilStatus).toBe('Unspecified');
    expect(result.householdStatus).toBe('Unspecified');
  });

  it('turns an empty nationality into null', () => {
    expect(normalizeResidentProfileFields({ nationality: '' }).nationality).toBeNull();
  });

  it('cuts long text to the allowed length', () => {
    const result = normalizeResidentProfileFields({
      nationality: 'n'.repeat(100),
      purokSitio: 'p'.repeat(200),
      streetAddress: 's'.repeat(300),
    });
    expect(result.nationality).toHaveLength(80);
    expect(result.purokSitio).toHaveLength(120);
    expect(result.streetAddress).toHaveLength(255);
  });

  it('keeps existing values when the body does not send them', () => {
    const existing = {
      gender: 'Male',
      civilStatus: 'Single',
      householdStatus: 'Household Head',
      nationality: 'Filipino',
      contactNumber: '09171234567',
      purokSitio: 'Purok 2',
      streetAddress: '5 Mabini St',
    };
    expect(normalizeResidentProfileFields({}, existing)).toEqual(existing);
  });

  it('lets the body override existing values', () => {
    const result = normalizeResidentProfileFields(
      { gender: 'Female' },
      { gender: 'Male', civilStatus: 'Single' },
    );
    expect(result.gender).toBe('Female');
    expect(result.civilStatus).toBe('Single');
  });

  it('rejects an unknown gender with a 400 error', () => {
    const error = getError(() => normalizeResidentProfileFields({ gender: 'Other' }));
    expect(error).not.toBeNull();
    expect(error.message).toBe('Invalid resident gender');
    expect(error.statusCode).toBe(400);
  });

  it('is case sensitive for gender', () => {
    expect(() => normalizeResidentProfileFields({ gender: 'female' })).toThrow(
      'Invalid resident gender',
    );
  });

  it('rejects an unknown civil status', () => {
    const error = getError(() =>
      normalizeResidentProfileFields({ civilStatus: 'Divorced' }),
    );
    expect(error.message).toBe('Invalid resident civil status');
    expect(error.statusCode).toBe(400);
  });

  it('rejects an unknown household status', () => {
    const error = getError(() =>
      normalizeResidentProfileFields({ householdStatus: 'Boarder' }),
    );
    expect(error.message).toBe('Invalid resident household status');
    expect(error.statusCode).toBe(400);
  });

  it('rejects a contact number with letters', () => {
    const error = getError(() =>
      normalizeResidentProfileFields({ contactNumber: 'abc1234' }),
    );
    expect(error.message).toContain('Contact number must be');
    expect(error.statusCode).toBe(400);
  });

  it('rejects a contact number that is too short', () => {
    expect(() =>
      normalizeResidentProfileFields({ contactNumber: '12345' }),
    ).toThrow('Contact number must be');
  });

  it('rejects a contact number that is too long', () => {
    expect(() =>
      normalizeResidentProfileFields({ contactNumber: '1'.repeat(21) }),
    ).toThrow('Contact number must be');
  });

  it('accepts contact numbers of 7 and 20 characters', () => {
    expect(
      normalizeResidentProfileFields({ contactNumber: '1234567' }).contactNumber,
    ).toBe('1234567');
    expect(
      normalizeResidentProfileFields({ contactNumber: '1'.repeat(20) })
        .contactNumber,
    ).toBe('1'.repeat(20));
  });

  it('accepts phone number formatting characters', () => {
    expect(
      normalizeResidentProfileFields({ contactNumber: '+63 (917) 123-4567' })
        .contactNumber,
    ).toBe('+63 (917) 123-4567');
  });

  it('allows clearing the contact number', () => {
    const result = normalizeResidentProfileFields(
      { contactNumber: '' },
      { contactNumber: '09171234567' },
    );
    expect(result.contactNumber).toBe('');
  });

  it('does not recheck a contact number that did not change', () => {
    const result = normalizeResidentProfileFields({}, { contactNumber: 'legacy-abc' });
    expect(result.contactNumber).toBe('legacy-abc');
  });

  it('rejects a changed contact number that is invalid', () => {
    expect(() =>
      normalizeResidentProfileFields(
        { contactNumber: 'abc' },
        { contactNumber: '09171234567' },
      ),
    ).toThrow('Contact number must be');
  });
});

describe('edge cases', () => {
  it('formatResidentAddress returns an empty string when called with no argument', () => {
    expect(formatResidentAddress()).toBe('');
  });

  it('formatResidentAddress returns an empty string for null', () => {
    expect(formatResidentAddress(null)).toBe('');
  });

  it('formatBeneficiaryStatus says not a beneficiary for text that is not a number', () => {
    expect(formatBeneficiaryStatus('abc')).toBe('Not a beneficiary');
  });
});