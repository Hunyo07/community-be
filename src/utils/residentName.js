// Formats a resident's display name from first, optional middle, and last parts.

export const formatResidentName = (firstName, middleName, lastName) =>
  [firstName, middleName, lastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");

export const normalizeMiddleName = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
};
