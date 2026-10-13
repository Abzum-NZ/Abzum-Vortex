import { ZodError } from "zod";

/**
 * The one definition failure type. `code` is the short, safe code a route boundary may show;
 * `cause` keeps the underlying database, parse or programming error for the server log.
 */
export class DefinitionError<Code extends string = string> extends Error {
  readonly code: Code;

  constructor(code: Code, options?: ErrorOptions & { detail?: string }) {
    super(options?.detail ? `${code}: ${options.detail}` : code, options);
    this.name = "DefinitionError";
    this.code = code;
  }
}

/** The Postgres SQLSTATE of a database failure, when the error carries one. */
export const databaseErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

/** The closed set of database failure kinds that services map to their own safe codes. */
export type DatabaseFailureKind =
  | "refused"
  | "conflict"
  | "duplicate"
  | "invalid"
  | "not_found"
  | "reference_missing"
  | "constraint_failed"
  | "wrong_state"
  | "other";

/**
 * The one SQLSTATE classification. Services choose their own error code per kind; only a real
 * database SQLSTATE is classified, so stored-data failures use their own typed errors instead.
 */
export const classifyDatabaseError = (error: unknown): DatabaseFailureKind => {
  switch (databaseErrorCode(error)) {
    case "42501":
      return "refused";
    case "40001":
      return "conflict";
    case "23505":
      return "duplicate";
    case "22023":
      return "invalid";
    case "P0002":
      return "not_found";
    case "23503":
      return "reference_missing";
    case "23514":
      return "constraint_failed";
    case "55000":
      return "wrong_state";
    default:
      return "other";
  }
};

const describeCause = (cause: unknown): string => {
  if (cause instanceof ZodError)
    return cause.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  const databaseCode = databaseErrorCode(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  return databaseCode === undefined ? message : `database ${databaseCode}: ${message}`;
};

/**
 * Builds a DefinitionError for an unexpected failure and logs the real cause (database code and
 * message, or Zod issues) on the server. Expected refusals are constructed directly instead.
 */
export const unexpectedDefinitionFailure = <Code extends string>(
  code: Code,
  cause: unknown,
  context: string,
): DefinitionError<Code> => {
  const error = new DefinitionError(code, { cause });
  console.error(`[definition] ${context} failed (${code}): ${describeCause(cause)}`, error);
  return error;
};

/** Logs a failure that the caller turns into a typed safe outcome, so the cause stays visible. */
export const reportUnexpectedFailure = (context: string, error: unknown): void => {
  console.error(`[definition] ${context} failed unexpectedly: ${describeCause(error)}`, error);
};
