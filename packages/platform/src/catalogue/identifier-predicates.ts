/** The platform's non-nil RFC UUID, shared by runtime values and identifier schemas. */
const platformIdentifierPattern =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

export const isPlatformIdentifier = (value: unknown): value is string =>
  typeof value === "string" && platformIdentifierPattern.test(value);
