import { isStableId } from "../catalogue/stable-id";
import type { RecordId, RecordTypeId } from "../catalogue/identifiers";
import { normalizeExactDecimal, parseExactDecimal } from "./exact-decimal";

const hasKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export const isMoneyValue = (value: unknown): value is { amount: string; currency: string } =>
  hasKeys(value, ["amount", "currency"]) &&
  typeof value.amount === "string" &&
  parseExactDecimal(value.amount) !== undefined &&
  normalizeExactDecimal(value.amount) === value.amount &&
  typeof value.currency === "string" &&
  /^[A-Z]{3}$/.test(value.currency);

export const isRecordLinkValue = (
  value: unknown,
): value is { recordTypeId: RecordTypeId; recordId: RecordId } =>
  hasKeys(value, ["recordTypeId", "recordId"]) &&
  isStableId(value.recordTypeId) &&
  isStableId(value.recordId);
