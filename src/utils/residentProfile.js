// Allowed values and display helpers for resident profile fields.

export const RESIDENT_GENDERS = ["Female", "Male", "Unspecified"];
export const RESIDENT_CIVIL_STATUSES = [
  "Single",
  "Married",
  "Widowed",
  "Separated",
  "Annulled",
  "Unspecified",
];
export const RESIDENT_HOUSEHOLD_STATUSES = [
  "Household Head",
  "Household Member",
  "Unspecified",
];

export const RESIDENT_CITY = "Tarlac City";

// Joins street, purok/sitio, and barangay into a single readable address.
export const formatResidentAddress = (address) => {
  const { streetAddress, purokSitio, barangay } = address ?? {};
  return [
    streetAddress,
    purokSitio,
    barangay ? `Brgy. ${barangay}` : "",
    barangay ? RESIDENT_CITY : "",
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
};

// Residents served by at least one program are considered beneficiaries.
export const formatBeneficiaryStatus = (servedCount) => {
  const count = Number(servedCount || 0);
  if (!Number.isFinite(count) || count <= 0) return "Not a beneficiary";
  return `Beneficiary (${count} program${count === 1 ? "" : "s"})`;
};

const trimOrEmpty = (value) => String(value ?? "").trim();

// Validates optional profile fields and returns normalized values; throws a 400 on bad input.
export const normalizeResidentProfileFields = (body, existing = {}) => {
  const pick = (key, fallback) =>
    body[key] !== undefined ? body[key] : (existing[key] ?? fallback);

  const fields = {
    gender: trimOrEmpty(pick("gender", "Unspecified")) || "Unspecified",
    civilStatus:
      trimOrEmpty(pick("civilStatus", "Unspecified")) || "Unspecified",
    nationality: trimOrEmpty(pick("nationality", "")).slice(0, 80) || null,
    householdStatus:
      trimOrEmpty(pick("householdStatus", "Unspecified")) || "Unspecified",
    contactNumber: trimOrEmpty(pick("contactNumber", "")).slice(0, 80),
    purokSitio: trimOrEmpty(pick("purokSitio", "")).slice(0, 120),
    streetAddress: trimOrEmpty(pick("streetAddress", "")).slice(0, 255),
  };

  const fail = (message) => {
    throw Object.assign(new Error(message), { statusCode: 400 });
  };

  if (!RESIDENT_GENDERS.includes(fields.gender)) fail("Invalid resident gender");
  if (!RESIDENT_CIVIL_STATUSES.includes(fields.civilStatus))
    fail("Invalid resident civil status");
  if (!RESIDENT_HOUSEHOLD_STATUSES.includes(fields.householdStatus))
    fail("Invalid resident household status");
  const contactChanged =
    fields.contactNumber !== trimOrEmpty(existing.contactNumber);
  if (
    contactChanged &&
    fields.contactNumber &&
    !/^[0-9+()\-\s]{7,20}$/.test(fields.contactNumber)
  )
    fail("Contact number must be 7-20 characters of digits, spaces, +, -, or parentheses");

  return fields;
};