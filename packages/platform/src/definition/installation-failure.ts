import "server-only";

import { describeFailure } from "../schema";
import { InstallationProblem, type InstallationProblemShape } from "./installation-authority";
import { DefinitionError, classifyDatabaseError } from "./definition-error";

/**
 * What an installation failure is shown to the caller as. The cause is logged here (class and
 * code, never the message); an unrecognised failure is classified by its database meaning and is
 * never turned into a "you need permission" refusal unless the database refused.
 */
export const classifyInstallationFailure = (error: unknown): InstallationProblemShape => {
  console.error(`[studio] application installation failed: ${describeFailure(error)}`);
  if (error instanceof InstallationProblem) return error.problem;
  if (error instanceof DefinitionError) {
    switch (error.code) {
      case "DEFINITION_DEPENDENCY_SUPERSEDED":
        return { kind: "refused", unavailableReason: "republish_required" };
      case "APPLICATION_INSTALLATION_STALE":
        return { kind: "conflict" };
      case "APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE":
        return { kind: "refused", unavailableReason: "storage_incompatible" };
      case "APPLICATION_INSTALLATION_PERMISSION_REFUSED":
      case "APPLICATION_INSTALLATION_REFUSED":
        return { kind: "refused" };
      case "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED":
        return { kind: "authentication_required" };
      case "APPLICATION_INSTALLATION_TEMPORARILY_UNAVAILABLE":
        return { kind: "temporarily_unavailable" };
      default:
        return { kind: "failed" };
    }
  }
  const kind = classifyDatabaseError(error);
  if (kind === "refused") return { kind: "refused" };
  if (kind === "conflict" || kind === "constraint_failed" || kind === "wrong_state")
    return { kind: "conflict" };
  return { kind: "temporarily_unavailable" };
};
