// Shared rules for new passwords on registration, reset, and change-password requests.

export const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters long, include at least 1 uppercase letter (A-Z), and include at least 1 special character. Spaces are not allowed.";

const PASSWORD_PATTERN = /^(?=.*[A-Z])(?=.*[^A-Za-z0-9\s])\S{8,}$/;

// True when the password meets length, uppercase, and special-character rules.
export const isValidAccountPassword = (password) => PASSWORD_PATTERN.test(String(password ?? ""));
