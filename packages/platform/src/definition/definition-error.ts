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
