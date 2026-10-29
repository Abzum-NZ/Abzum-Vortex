/** An RFC 9562 platform identifier, excluding the nil UUID. */
export const isStableId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
    value,
  );
