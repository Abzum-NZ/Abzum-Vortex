import "server-only";

import { describeFailure } from "../catalogue/runtime-primitives";
import { BuilderAuthorityError } from "../definition/builder-authority";
import { DefinitionError } from "../definition/definition-error";
import { FirstInstallUnavailable } from "../definition/installation-first-install";
import { InstallationProblem } from "../definition/installation-authority";
import {
  classifyThroughCauses,
  definitionCodeClass,
  fault,
  refusal,
  retryable,
  type RequestFailureClass,
} from "./request-failure-table";

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
  // A named state (not installed, storage incompatible, ...) is an answer.
  if (problem.unavailableReason !== undefined || problem.kind === "refused") return refusal();
  return problem.kind === "conflict" ? retryable("temporarily unavailable") : fault();
};

/** The classes of the errors this classifier names by their own type. */
const requestFailureRules = (error: unknown): RequestFailureClass | undefined => {
  if (error instanceof DefinitionError) return definitionCodeClass(error.code);
  if (error instanceof BuilderAuthorityError) return builderAuthorityClasses[error.code];
  if (error instanceof FirstInstallUnavailable) return refusal();
  if (error instanceof InstallationProblem) return installationProblemClass(error.problem);
  return undefined;
};

/**
 * The one classification of a failed request, by the error's class and code. An error the table
 * does not name (a wrapper such as a definition failure around a database error) is classified by
 * the first of its causes the table names; none means a platform fault.
 */
export const classifyRequestFailure = (
  error: unknown,
  scope: Readonly<{ addressed: boolean }>,
): RequestFailureClass => classifyThroughCauses(error, scope, requestFailureRules);

/**
 * The one line for a failure caught outside the request runner (which logs its own answers): at
 * the level its class decides, so a refusal or a moved state is information and a fault an error.
 */
export const logClassifiedFailure = (line: string, error: unknown): void => {
  if (classifyRequestFailure(error, { addressed: false }).level === "info") console.info(line);
  else console.error(line);
};

/**
 * The one server-side line for a refusal or a caught failure: the route or service, the operation,
 * a stable reason code and, when there is one, the safe description of its cause (class names and
 * codes only). Ids may be part of `op`; personal data, values and secrets never are. Without a
 * cause it is an expected refusal and information; with one the cause's class decides the level.
 */
export const logRefusal = (route: string, op: string, code: string, cause?: unknown): void => {
  const message = `[${route}] ${op} refused: code=${code}`;
  if (cause === undefined) console.info(message);
  else logClassifiedFailure(`${message} cause=${describeFailure(cause)}`, cause);
};
