import "server-only";

import { describeFailure } from "../schema";
import { InstallationArchiveConnectionError } from "./installation-archive-connections";
import { InstallationProblem, type InstallationProblemShape } from "./installation-authority";
import { DefinitionError, classifyDatabaseError } from "./definition-error";
import { ProvisionedSetupError } from "./installation-provisioned-setup";

/**
 * What an installation failure is shown to the caller as. The cause is logged here (class and
 * code, never the message); an unrecognised failure is classified by its database meaning and is
 * never turned into a "you need permission" refusal unless the database refused.
 */
export const classifyInstallationFailure = (error: unknown): InstallationProblemShape => {
  console.error(`[studio] application installation failed: ${describeFailure(error)}`);
  if (error instanceof InstallationProblem) return error.problem;
  if (error instanceof InstallationArchiveConnectionError) return { kind: error.reason };
  if (error instanceof ProvisionedSetupError) return { kind: "refused" };
  if (error instanceof DefinitionError) {
    switch (error.code) {
      case "APPLICATION_INSTALLATION_STALE":
        return { kind: "conflict" };
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
