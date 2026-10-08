// Shared person-name rules for residents and staff. Letters include ñ and accents.

const PERSON_NAME_PATTERN = /^[\p{L}][\p{L} .'-]*$/u;

export const personNameMessage = (label) =>
  `${label} can only contain letters, spaces, hyphens, apostrophes, and periods.`;

const fail = (message) => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};

// Trims a name and rejects digits, symbols, and values that are empty when required.
export const assertPersonName = (value, label, { required = true, maxLength = 100 } = {}) => {
  const trimmed = String(value ?? '').trim().replace(/\s+/g, ' ');

  if (!trimmed) {
    if (!required) return null;
    fail(`${label} is required`);
  }

  if (trimmed.length > maxLength) {
    fail(`${label} must be ${maxLength} characters or fewer.`);
  }

  if (!PERSON_NAME_PATTERN.test(trimmed)) {
    fail(personNameMessage(label));
  }

  return trimmed;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Trims an email and rejects a missing or malformed address.
export const assertEmail = (value, { maxLength = 180 } = {}) => {
  const email = String(value ?? '').trim();

  if (!email) fail('Email is required');
  if (email.length > maxLength) fail(`Email must be ${maxLength} characters or fewer.`);
  if (!EMAIL_PATTERN.test(email)) fail('Email is not a valid email address.');

  return email;
};
