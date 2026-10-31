import { asRecord } from "../catalogue/runtime-primitives";

/** The longest event consumer key in characters; every consumer path bounds it the same way. */
export const maximumEventConsumerKeyLength = 128;

/**
 * A consumer key names one consumer in every event path: letters, digits, dot, underscore, colon
 * and dash, starting with a letter or digit, at most 128 characters.
 */
export const consumerKeyMatches = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= maximumEventConsumerKeyLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** A record whose keys are exactly these, each present once and no other key; undefined otherwise. */
export const exactRecord = <Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Readonly<Record<Key, unknown>> | undefined => {
  const candidate = asRecord(value);
  if (
    candidate === undefined ||
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(candidate, key))
  )
    return undefined;
  return candidate as Readonly<Record<Key, unknown>>;
};
