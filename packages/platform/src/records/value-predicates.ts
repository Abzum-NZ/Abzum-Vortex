import { isPlatformIdentifier } from "../catalogue/identifier-predicates";
import { normalizeExactDecimal } from "./exact-decimal";

const objectWithKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export const isCanonicalExactDecimal = (value: unknown): value is string =>
  typeof value === "string" && normalizeExactDecimal(value) === value;

export const currencyCodePattern = /^[A-Z]{3}$/;
const isCurrencyCode = (value: unknown): value is string =>
  typeof value === "string" && currencyCodePattern.test(value);

export const isMoneyValue = (value: unknown): value is { amount: string; currency: string } =>
  objectWithKeys(value, ["amount", "currency"]) &&
  isCanonicalExactDecimal(value.amount) &&
  isCurrencyCode(value.currency);

export const isRecordLinkValue = (
  value: unknown,
): value is { recordTypeId: string; recordId: string } =>
  objectWithKeys(value, ["recordTypeId", "recordId"]) &&
  isPlatformIdentifier(value.recordTypeId) &&
  isPlatformIdentifier(value.recordId);
