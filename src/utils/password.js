import crypto from "node:crypto";

// This utility securely hashes passwords before storing them in the database.
// It uses a strong password hashing method so plain passwords are not kept as-is.

// Creates a salted PBKDF2 hash string that can be stored in the database.
export const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");
  return `pbkdf2_sha512$100000$${salt}$${hash}`;
};

// Re-hashes the candidate password with the stored salt and compares safely.
export const verifyPassword = (password, storedHash) => {
  const [algorithm, iterations, salt, hash] = storedHash.split("$");

  if (algorithm !== "pbkdf2_sha512" || !iterations || !salt || !hash) {
    return false;
  }

  const candidate = crypto
    .pbkdf2Sync(password, salt, Number(iterations), 64, "sha512")
    .toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(candidate, "hex"),
    Buffer.from(hash, "hex"),
  );
};
