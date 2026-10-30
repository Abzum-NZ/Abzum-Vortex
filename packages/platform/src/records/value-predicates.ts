import { normalizeExactDecimal } from "./exact-decimal";

export const isCanonicalExactDecimal = (value: unknown): value is string =>
  typeof value === "string" && normalizeExactDecimal(value) === value;

export const currencyCodePattern = /^[A-Z]{3}$/;
