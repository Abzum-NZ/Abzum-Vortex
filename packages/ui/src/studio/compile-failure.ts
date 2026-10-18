/** Why the saved draft would not compile, with where, when the platform located it. */
export type StudioCompileFailure = Readonly<{
  reasonCode: string;
  family: string;
  blockAlias?: string;
  tokenKey?: string;
  /** The module, record type, field or query the refusal is about. */
  moduleKey?: string;
  recordTypeKey?: string;
  fieldKey?: string;
  queryKey?: string;
}>;
