import "server-only";

import { ZodError } from "zod";
import { databaseCode } from "../catalogue/runtime-primitives";
import { BuilderAuthorityError } from "../definition/builder-authority";
import { DefinitionError, isValidationRefusal } from "../definition/definition-error";
import { FirstInstallUnavailable } from "../definition/installation-first-install";
import { InstallationProblem } from "../definition/installation-authority";
import type { TelemetryOutcome } from "../events/telemetry";

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
  /** The place that raised it already logged it once, so the runner adds no line. */
  sourceLogged: boolean;
}>;

const refusal = (
  answer: RequestFailureAnswer = "refused",
  sourceLogged = false,
): RequestFailureClass => ({
  answer,
  level: "info",
  outcome: "refused",
  verb: "refused",
  sourceLogged,
});

/** A state that moved or a request that was stopped: logged as information, tried again. */
const retryable = (verb: "stopped" | "temporarily unavailable"): RequestFailureClass => ({
  answer: "temporarily_unavailable",
  level: "info",
  outcome: "temporarily_unavailable",
  verb,
  sourceLogged: false,
});

const fault = (sourceLogged = false): RequestFailureClass => ({
  answer: "temporarily_unavailable",
  level: "error",
  outcome: "temporarily_unavailable",
  verb: "failed",
  sourceLogged,
});

export const refusedRequestFailure: RequestFailureClass = refusal();
export const faultRequestFailure: RequestFailureClass = fault();

/** The definition failures that are answers, not faults, by their code. */
const definitionErrorClasses: ReadonlyMap<string, RequestFailureClass> = new Map([
  ["DEFINITION_NO_CHANGE", refusal()],
  ["DEFINITION_CONTEXT_REFUSED", refusal()],
  ["DEFINITION_DRAFT_STALE_OR_MISSING", refusal()],
  ["DEFINITION_DEPENDENCY_SUPERSEDED", refusal()],
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

/** The database's own answers (SQLSTATE and the access model's codes). */
const databaseCodeClasses: ReadonlyMap<string, RequestFailureClass> = new Map([
  ["V3140", refusal("suspended_account")],
  ["V3150", refusal("recent_authentication_required")],
  ["V3151", refusal("role_settings_change_required")],
  ["V3152", refusal("multi_factor_required")],
  ["V3153", refusal("role_key_in_use")],
  ["40001", retryable("temporarily unavailable")],
]);

const builderAuthorityClasses: Readonly<
  Record<BuilderAuthorityError["code"], RequestFailureClass>
> = {
  BUILDER_PERMISSION_REFUSED: refusal(),
  BUILDER_RECENT_AUTHENTICATION_REQUIRED: refusal("recent_authentication_required"),
  BUILDER_MULTI_FACTOR_REQUIRED: refusal("multi_factor_required"),
};

const installationProblemClass = (problem: InstallationProblem["problem"]): RequestFailureClass => {
  if (problem.kind === "authentication_required") return refusal("recent_authentication_required");
  if (problem.kind === "multi_factor_required") return refusal("multi_factor_required");
  // A named state (republish required, not installed, storage incompatible, ...) is an answer.
  if (problem.unavailableReason !== undefined || problem.kind === "refused") return refusal();
  return problem.kind === "conflict" ? retryable("temporarily unavailable") : fault();
};

/**
 * A request its caller abandoned (the browser left the page) is stopped on purpose. The database
 * layer raises it as a plain error named for its layer, and the platform as an abort.
 */
const requestStopped = (error: unknown): boolean =>
  error instanceof Error &&
  ((error.name === "VortexDatabaseError" && error.message === "DATABASE_REQUEST_STOPPED") ||
    error.name === "AbortError");

/**
 * The one classification of a failed request, by the error's class and code. Postgres reports a
 * missing privilege (a lost GRANT, a role misconfiguration) with the same code as the access
 * model's refusals, but always as "permission denied for ...": that is a fault.
 */
export const classifyRequestFailure = (
  error: unknown,
  scope: Readonly<{ addressed: boolean }>,
): RequestFailureClass => {
  if (requestStopped(error)) return retryable("stopped");
  if (error instanceof DefinitionError) {
    // The publication source logged a failed publication once: a stored-schema failure at error,
    // a compiler refusal (a rule naming what to fix) at info.
    if (error.code === "DEFINITION_PUBLICATION_FAILED") {
      if (isValidationRefusal(error.cause)) return refusal("refused", true);
      return fault(error.cause instanceof ZodError);
    }
    return definitionErrorClasses.get(error.code) ?? fault();
  }
  if (error instanceof BuilderAuthorityError) return builderAuthorityClasses[error.code];
  if (error instanceof FirstInstallUnavailable) return refusal();
  if (error instanceof InstallationProblem) return installationProblemClass(error.problem);
  const code = databaseCode(error);
  if (code === undefined) return fault();
  const known = databaseCodeClasses.get(code);
  if (known !== undefined) return known;
  if (code === "42501")
    return error instanceof Error && error.message.startsWith("permission denied for ")
      ? fault()
      : refusal();
  return code === "P0002" && scope.addressed ? refusal() : fault();
};

/**
 * The one line for a read that failed outside the request runner (which logs its own answers): at
 * the level its class decides, so a refusal or a moved state is information and a fault an error.
 */
export const logReadFailure = (line: string, error: unknown): void => {
  if (classifyRequestFailure(error, { addressed: false }).level === "info") console.info(line);
  else console.error(line);
};
