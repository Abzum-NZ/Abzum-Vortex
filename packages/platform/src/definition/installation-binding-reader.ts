import "server-only";

import {
  activeApplicationInstallationEvidenceSchema,
  type ActiveApplicationInstallationErrorCode,
  type ActiveApplicationInstallationEvidence,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

type ActiveInstallationRow = DatabaseRow & { readonly active_installation: unknown };

const mapFailure = (error: unknown): DefinitionError<ActiveApplicationInstallationErrorCode> => {
  if (error instanceof DefinitionError) return error;
  switch (classifyDatabaseError(error)) {
    case "refused":
    case "invalid":
      return new DefinitionError("ACTIVE_APPLICATION_CONTEXT_REFUSED", { cause: error });
    case "not_found":
      return new DefinitionError("ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE", { cause: error });
    case "constraint_failed":
    case "wrong_state":
      return new DefinitionError("ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE", { cause: error });
    default:
      return unexpectedDefinitionFailure(
        "ACTIVE_APPLICATION_INSTALLATION_READ_FAILED",
        error,
        "active installation read",
      );
  }
};

export interface ActiveApplicationInstallationRepository {
  readCurrent(): Promise<ActiveApplicationInstallationEvidence>;
}

/** Reads only the active installation selected by trusted human application context. */
export const createActiveApplicationInstallationRepository = (
  transaction: RequestDatabaseTransaction,
): ActiveApplicationInstallationRepository =>
  Object.freeze({
    async readCurrent() {
      try {
        const rows = await transaction.query<ActiveInstallationRow>`
          select vortex_definition.read_current_active_installation() as active_installation
        `;
        if (rows.length !== 1 || rows[0] === undefined || rows[0].active_installation === null)
          throw new DefinitionError("ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE");
        const result = activeApplicationInstallationEvidenceSchema.safeParse(
          rows[0].active_installation,
        );
        if (!result.success)
          throw unexpectedDefinitionFailure(
            "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE",
            result.error,
            "installation-binding-reader",
          );
        return result.data;
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
