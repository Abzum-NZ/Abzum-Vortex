/** Why the saved draft would not compile, with where, when the platform located it. */
export type StudioCompileFailure = Readonly<{
  reasonCode: string;
  family: string;
  /** The rule's own business sentence, when it has one (a Records table feature check, for one). */
  sentence?: string;
  blockAlias?: string;
  tokenKey?: string;
  /** The module, record type, field or query the refusal is about. */
  moduleKey?: string;
  /** The dependency path when several modules take part in a refusal. */
  moduleKeys?: readonly string[];
  recordTypeKey?: string;
  fieldKey?: string;
  queryKey?: string;
  /** The flow and the step in it the refusal is about. */
  flowKey?: string;
  taskId?: string;
}>;
