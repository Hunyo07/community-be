import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../src/utils/password.js';

describe('hashPassword', () => {
  it('returns the format algorithm$iterations$salt$hash', () => {
    const stored = hashPassword('Password1');
    const [algorithm, iterations, salt, hash] = stored.split('$');

    expect(algorithm).toBe('pbkdf2_sha512');
    expect(iterations).toBe('100000');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('does not contain the plain password', () => {
    expect(hashPassword('Password1')).not.toContain('Password1');
  });

  it('creates a different hash each time for the same password (random salt)', () => {
    expect(hashPassword('Password1')).not.toBe(hashPassword('Password1'));
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct password', () => {
    const stored = hashPassword('Password1');
    expect(verifyPassword('Password1', stored)).toBe(true);
  });

  it('returns false for a wrong password', () => {
    const stored = hashPassword('Password1');
    expect(verifyPassword('Password2', stored)).toBe(false);
  });

  it('is case sensitive', () => {
    const stored = hashPassword('Password1');
    expect(verifyPassword('password1', stored)).toBe(false);
  });

  it('works with non-English characters', () => {
    const stored = hashPassword('Pässwörd日本');
    expect(verifyPassword('Pässwörd日本', stored)).toBe(true);
  });

  it('returns false when the stored hash was changed', () => {
    const stored = hashPassword('Password1');
    const lastChar = stored.slice(-1);
    const tampered = stored.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    expect(verifyPassword('Password1', tampered)).toBe(false);
  });

  it('returns false for an unknown algorithm name', () => {
    const stored = hashPassword('Password1');
    const wrongAlgorithm = stored.replace('pbkdf2_sha512', 'md5');
    expect(verifyPassword('Password1', wrongAlgorithm)).toBe(false);
  });

  it('returns false when parts of the stored hash are missing', () => {
    expect(verifyPassword('Password1', '')).toBe(false);
    expect(verifyPassword('Password1', 'garbage')).toBe(false);
    expect(verifyPassword('Password1', 'pbkdf2_sha512$100000')).toBe(false);
    expect(verifyPassword('Password1', 'pbkdf2_sha512$100000$abcd')).toBe(false);
  });

  it('accepts a hash built independently with standard PBKDF2', () => {
    const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const hash = crypto
      .pbkdf2Sync('Password1', salt, 100000, 64, 'sha512')
      .toString('hex');
    const stored = `pbkdf2_sha512$100000$${salt}$${hash}`;

    expect(verifyPassword('Password1', stored)).toBe(true);
    expect(verifyPassword('Wrong1234', stored)).toBe(false);
  });

  it('verifies two hashes of the same password independently', () => {
    const first = hashPassword('Password1');
    const second = hashPassword('Password1');

    expect(verifyPassword('Password1', first)).toBe(true);
    expect(verifyPassword('Password1', second)).toBe(true);
  });
});