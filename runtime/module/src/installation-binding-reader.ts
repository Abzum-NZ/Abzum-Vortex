import "server-only";

import {
  activeApplicationInstallationEvidenceSchema,
  type ActiveApplicationInstallationErrorCode,
  type ActiveApplicationInstallationEvidence,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

type ActiveInstallationRow = DatabaseRow & { readonly active_installation: unknown };

export class ActiveApplicationInstallationError extends Error {
  readonly code: ActiveApplicationInstallationErrorCode;

  constructor(code: ActiveApplicationInstallationErrorCode) {
    super(code);
    this.name = "ActiveApplicationInstallationError";
    this.code = code;
  }
}

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): ActiveApplicationInstallationError => {
  if (error instanceof ActiveApplicationInstallationError) return error;
  switch (databaseCode(error)) {
    case "42501":
    case "22023":
      return new ActiveApplicationInstallationError("ACTIVE_APPLICATION_CONTEXT_REFUSED");
    case "P0002":
      return new ActiveApplicationInstallationError("ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE");
    case "23514":
    case "55000":
      return new ActiveApplicationInstallationError("ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE");
    default:
      return new ActiveApplicationInstallationError("ACTIVE_APPLICATION_INSTALLATION_READ_FAILED");
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
          select vortex_module.read_current_active_installation() as active_installation
        `;
        if (rows.length !== 1 || rows[0] === undefined || rows[0].active_installation === null)
          throw new ActiveApplicationInstallationError(
            "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE",
          );
        const result = activeApplicationInstallationEvidenceSchema.safeParse(
          rows[0].active_installation,
        );
        if (!result.success)
          throw new ActiveApplicationInstallationError(
            "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE",
          );
        return result.data;
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
