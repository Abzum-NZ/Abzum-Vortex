import "server-only";

import { databaseCode } from "../catalogue/runtime-primitives";
import { DefinitionCompilationError } from "../definition/compilation-error";
import type { TelemetryOutcome } from "../events/telemetry";

/**
 * The leaf of the one classification of a failed request: the classes, the tables of codes and the
 * one walk over an error's causes. It imports only the primitives and the compiler's refusal, so
 * the request classifier and the definition failure logger both use it without an import cycle.
 */

/** What the person is told; the runner builds the result from it. */
type RequestFailureAnswer =
  | "refused"
  | "suspended_account"
  | "temporarily_unavailable"
  | "recent_authentication_required"
  | "multi_factor_required"
  | "role_settings_change_required"
  | "role_key_in_use";

/**
 * What one failed request is, decided once: the level of its one log line, the answer the caller
 * sees and the telemetry counter. A refusal is information, answered as a refusal and counted as
 * one; only a platform fault is an error, answered "try again" and counted as an outage.
 */
export type RequestFailureClass = Readonly<{
  answer: RequestFailureAnswer;
  level: "info" | "error";
  outcome: TelemetryOutcome;
  /** The verb the one log line uses. */
  verb: "refused" | "stopped" | "temporarily unavailable" | "failed";
}>;

export const refusal = (answer: RequestFailureAnswer = "refused"): RequestFailureClass => ({
  answer,
  level: "info",
  outcome: "refused",
  verb: "refused",
});

/** A state that moved or a request that was stopped: logged as information, tried again. */
export const retryable = (verb: "stopped" | "temporarily unavailable"): RequestFailureClass => ({
  answer: "temporarily_unavailable",
  level: "info",
  outcome: "temporarily_unavailable",
  verb,
});

export const fault = (): RequestFailureClass => ({
  answer: "temporarily_unavailable",
  level: "error",
  outcome: "temporarily_unavailable",
  verb: "failed",
});

export const refusedRequestFailure: RequestFailureClass = refusal();
export const faultRequestFailure: RequestFailureClass = fault();

/** The definition failures that are answers, not faults, by their code. */
const definitionErrorClasses: ReadonlyMap<string, RequestFailureClass> = new Map([
  ["DEFINITION_NO_CHANGE", refusal()],
  ["DEFINITION_CONTEXT_REFUSED", refusal()],
  ["DEFINITION_DRAFT_STALE_OR_MISSING", refusal()],
  ["RECORD_STORAGE_INCOMPATIBLE", refusal()],
  ["APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE", refusal()],
  ["APPLICATION_INSTALLATION_PERMISSION_REFUSED", refusal()],
  ["APPLICATION_INSTALLATION_REFUSED", refusal()],
  [
    "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED",
    refusal("recent_authentication_required"),
  ],
  ["APPLICATION_INSTALLATION_MULTI_FACTOR_REQUIRED", refusal("multi_factor_required")],
  ["APPLICATION_INSTALLATION_STALE", retryable("temporarily unavailable")],
]);

/** The class a definition failure's own code names; undefined when the code is not an answer. */
export const definitionCodeClass = (code: string): RequestFailureClass | undefined =>
  definitionErrorClasses.get(code);

/** The database's own answers (SQLSTATE and the access model's codes). */
const databaseCodeClasses: ReadonlyMap<string, RequestFailureClass> = new Map([
  ["V3140", refusal("suspended_account")],
  ["V3150", refusal("recent_authentication_required")],
  ["V3151", refusal("role_settings_change_required")],
  ["V3152", refusal("multi_factor_required")],
  ["V3153", refusal("role_key_in_use")],
  // The identity and command-receipt answers: a duplicate or a command id reused under another
  // scope or kind (V3001, every scoped command receipt), an unavailable steward or scope, a missing
  // tenant capability, a stale revision, the last manager, an unavailable identity, a reserved
  // short name. Retrying the same command cannot succeed, so none is "try again".
  ["V3001", refusal()],
  ["V3002", refusal()],
  ["V3003", refusal()],
  ["V3101", refusal()],
  ["V3102", refusal()],
  ["V3103", refusal()],
  ["V3141", refusal()],
  ["V3143", refusal()],
  ["V3190", refusal()],
  ["40001", retryable("temporarily unavailable")],
]);

/**
 * A request its caller abandoned (the browser left the page) is stopped on purpose. The database
 * layer raises it as a plain error named for its layer, and the platform as an abort. A connection
 * reset is not matched here: the database pool and outbound calls raise the same `ECONNRESET`, and
 * those are faults; the one reader of a client's upload says its own stop.
 */
const requestStopped = (error: unknown): boolean =>
  error instanceof Error &&
  ((error.name === "VortexDatabaseError" && error.message === "DATABASE_REQUEST_STOPPED") ||
    error.name === "AbortError");

/** What one class of error means, by an error type only its caller can name. */
export type FailureClassRules = (error: unknown) => RequestFailureClass | undefined;

/** The class the error itself names by the shared rules, or `rules`; undefined when none does. */
const knownClass = (
  error: unknown,
  scope: Readonly<{ addressed: boolean }>,
  rules: FailureClassRules,
): RequestFailureClass | undefined => {
  if (requestStopped(error)) return retryable("stopped");
  // A compiler refusal names a rule the author fixes: an answer, wherever it is caught. A failure
  // that wraps it (a failed publication) is classified by it as one of its causes.
  if (error instanceof DefinitionCompilationError) return refusal();
  const own = rules(error);
  if (own !== undefined) return own;
  const code = databaseCode(error);
  if (code === undefined) return undefined;
  const known = databaseCodeClasses.get(code);
  if (known !== undefined) return known;
  // Postgres reports a missing privilege (a lost GRANT, a role misconfiguration) with the same
  // code as the access model's refusals, but always as "permission denied for ...": a fault.
  if (code === "42501")
    return error instanceof Error && error.message.startsWith("permission denied for ")
      ? fault()
      : refusal();
  return code === "P0002" && scope.addressed ? refusal() : undefined;
};

/**
 * The one walk over an error and its causes: the class of the first the shared rules or `rules`
 * name; none means a platform fault. A wrapper such as a definition failure around a database
 * error is classified by its cause.
 */
export const classifyThroughCauses = (
  error: unknown,
  scope: Readonly<{ addressed: boolean }>,
  rules: FailureClassRules,
): RequestFailureClass => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const known = knownClass(current, scope, rules);
    if (known !== undefined) return known;
    current = current instanceof Error ? current.cause : undefined;
  }
  return fault();
};
