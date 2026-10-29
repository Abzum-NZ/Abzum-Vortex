/** The limit shared by authored links and web-address values. */
export const safeHttpsUrlMaximumLength = 2_048;

/** The URL format parser preserves text but removes surrounding whitespace and tabs/newlines. */
export const normalizeHttpsUrlText = (value: string): string =>
  value.trim().replace(/[\t\n\r]/g, "");

/** The approved URL shape used by both validated contracts and the flow runtime. */
export const isSafeHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const normalized = normalizeHttpsUrlText(value);
  if (normalized.length > safeHttpsUrlMaximumLength) return false;
  try {
    const address = new URL(normalized);
    return (
      address.protocol === "https:" &&
      address.username === "" &&
      address.password === "" &&
      !address.hostname.includes("%")
    );
    // guard-allow: silent-catch URL parsing failure means the address is invalid.
  } catch {
    return false;
  }
};
