import { markRequestFailureLogged, requestFailureLogged } from "../access/request-failure-mark";
import {
  classifyThroughCauses,
  definitionCodeClass,
  type RequestFailureClass,
} from "../access/request-failure-table";
import { databaseCode, describeFailure } from "../catalogue/runtime-primitives";

/**
 * The one definition failure type. `code` is the short, safe code a route boundary may show;
 * `cause` keeps the underlying database, parse or programming error for the server log.
 */
export class DefinitionError<Code extends string = string> extends Error {
  readonly code: Code;
  readonly sentence: string | undefined;

  constructor(code: Code, options?: ErrorOptions & { detail?: string; sentence?: string }) {
    super(options?.detail ? `${code}: ${options.detail}` : code, options);
    this.name = "DefinitionError";
    this.code = code;
    this.sentence = options?.sentence;
  }
}

/** The closed set of database failure kinds that services map to their own safe codes. */
type DatabaseFailureKind =
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
  switch (databaseCode(error)) {
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

/** The classes of the errors this module names by their own type: a definition failure by its code. */
const definitionFailureRules = (error: unknown): RequestFailureClass | undefined =>
  error instanceof DefinitionError ? definitionCodeClass(error.code) : undefined;

const logDefinitionFailure = (failure: RequestFailureClass, line: string): void => {
  if (failure.level === "info") console.info(line);
  else console.error(line);
};

/**
 * Builds a DefinitionError for an unexpected failure and logs it on the server once, at the level
 * the one classification gives its cause: an answer (a rule refusing the draft, a moved state, a
 * database refusal) is information, a platform fault an error. The line names the context, the
 * code and the safe description of the cause chain, never a message or a raw error.
 */
export const unexpectedDefinitionFailure = <Code extends string>(
  code: Code,
  cause: unknown,
  context: string,
): DefinitionError<Code> => {
  const error = new DefinitionError(code, { cause });
  // A failure an inner source already logged is not logged again by the failure that wraps it.
  if (requestFailureLogged(cause)) return markRequestFailureLogged(error);
  const failure = classifyThroughCauses(error, { addressed: false }, definitionFailureRules);
  logDefinitionFailure(
    failure,
    `[definition] ${context} ${failure.verb} (${code}): ${describeFailure(cause)}`,
  );
  // The request runner that catches this failure adds no second line.
  return markRequestFailureLogged(error);
};

/** Logs a failure that the caller turns into a typed safe outcome, so the cause stays visible. */
export const reportUnexpectedFailure = (context: string, error: unknown): void => {
  const failure = classifyThroughCauses(error, { addressed: false }, definitionFailureRules);
  logDefinitionFailure(
    failure,
    `[definition] ${context} ${failure.level === "error" ? "failed unexpectedly" : failure.verb}: ${describeFailure(error)}`,
  );
};
