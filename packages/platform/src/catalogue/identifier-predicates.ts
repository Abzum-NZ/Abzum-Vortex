/** A key entered by a builder in a definition. */
export const isBuilderKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 40 &&
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value);
