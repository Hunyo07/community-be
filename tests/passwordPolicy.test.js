import { describe, it, expect } from 'vitest';
import {
  isValidAccountPassword,
  PASSWORD_POLICY_MESSAGE,
} from '../src/utils/passwordPolicy.js';

describe('isValidAccountPassword', () => {
  describe('valid passwords', () => {
    it('accepts letters, numbers, and one uppercase', () => {
      expect(isValidAccountPassword('Password1')).toBe(true);
    });

    it('accepts the minimum length of 8 characters', () => {
      expect(isValidAccountPassword('Abcdefg1')).toBe(true);
    });

    it('accepts uppercase letters only (numbers not required)', () => {
      expect(isValidAccountPassword('ABCDEFGH')).toBe(true);
    });

    it('accepts passwords longer than 13 characters (no maximum)', () => {
      expect(isValidAccountPassword('Abcdefghijkl1')).toBe(true);
      expect(isValidAccountPassword('Abcdefghijklm1')).toBe(true);
      expect(isValidAccountPassword('A' + 'b'.repeat(48) + '1')).toBe(true);
    });
  });

  describe('invalid length', () => {
    it('rejects 7 characters (too short)', () => {
      expect(isValidAccountPassword('Abcdef1')).toBe(false);
    });

    it('rejects a 1 character password', () => {
      expect(isValidAccountPassword('A')).toBe(false);
    });
  });

  describe('invalid characters', () => {
    it('rejects a password with no uppercase letter', () => {
      expect(isValidAccountPassword('password1')).toBe(false);
    });

    it('rejects a long password with no uppercase letter', () => {
      expect(isValidAccountPassword('abcdefghijklmnopqrstuvwxyz1')).toBe(false);
    });

    it('rejects special characters', () => {
      expect(isValidAccountPassword('Password1!')).toBe(false);
    });

    it('rejects spaces', () => {
      expect(isValidAccountPassword('Pass word1')).toBe(false);
    });

    it('rejects underscores and dashes', () => {
      expect(isValidAccountPassword('Pass_word1')).toBe(false);
      expect(isValidAccountPassword('Pass-word1')).toBe(false);
    });

    it('rejects a long password with a special character', () => {
      expect(isValidAccountPassword('Abcdefghijklmnopq1!')).toBe(false);
    });
  });

  describe('empty or non-string input', () => {
    it('rejects an empty string', () => {
      expect(isValidAccountPassword('')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidAccountPassword(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidAccountPassword(undefined)).toBe(false);
    });

    it('rejects a number with no uppercase letter', () => {
      expect(isValidAccountPassword(12345678)).toBe(false);
    });
  });
});

describe('PASSWORD_POLICY_MESSAGE', () => {
  it('describes the length rule', () => {
    expect(PASSWORD_POLICY_MESSAGE).toContain('at least 8 characters');
  });

  it('does not mention a maximum length', () => {
    expect(PASSWORD_POLICY_MESSAGE).not.toContain('13');
  });

  it('mentions the uppercase requirement', () => {
    expect(PASSWORD_POLICY_MESSAGE).toContain('uppercase');
  });
});