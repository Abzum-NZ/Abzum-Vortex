import "server-only";

import {
  applicationInstallationActivationCommandSchema,
  applicationInstallationDetachCommandSchema,
  applicationInstallationLifecycleResultSchema,
  applicationLifecyclePolicyReadinessSchema,
  validateRecordTypeLifecyclePolicy,
  type ApplicationInstallationActivationCommand,
  type ApplicationInstallationDetachCommand,
  type ApplicationInstallationLifecycleErrorCode,
  type ApplicationInstallationLifecycleResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

type LifecycleRow = DatabaseRow & { readonly lifecycle_result: unknown };
type LifecyclePolicyReadinessRow = DatabaseRow & { readonly lifecycle_readiness: unknown };

export class ApplicationInstallationLifecycleError extends Error {
  readonly code: ApplicationInstallationLifecycleErrorCode;

  constructor(code: ApplicationInstallationLifecycleErrorCode) {
    super(code);
    this.name = "ApplicationInstallationLifecycleError";
    this.code = code;
  }
}

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): ApplicationInstallationLifecycleError => {
  if (error instanceof ApplicationInstallationLifecycleError) return error;
  switch (databaseCode(error)) {
    case "22023":
      return new ApplicationInstallationLifecycleError(
        "INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND",
      );
    case "42501":
      return new ApplicationInstallationLifecycleError(
        "APPLICATION_INSTALLATION_AUTHORITY_REFUSED",
      );
    case "P0002":
      return new ApplicationInstallationLifecycleError(
        "APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE",
      );
    case "40001":
      return new ApplicationInstallationLifecycleError("APPLICATION_INSTALLATION_BINDING_CONFLICT");
    case "23514":
    case "55000":
      return new ApplicationInstallationLifecycleError(
        "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE",
      );
    default:
      return new ApplicationInstallationLifecycleError("APPLICATION_INSTALLATION_CHANGE_FAILED");
  }
};

const parseResult = (rows: readonly LifecycleRow[]): ApplicationInstallationLifecycleResult => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new ApplicationInstallationLifecycleError("APPLICATION_INSTALLATION_CHANGE_FAILED");
  const result = applicationInstallationLifecycleResultSchema.safeParse(rows[0].lifecycle_result);
  if (!result.success)
    throw new ApplicationInstallationLifecycleError("APPLICATION_INSTALLATION_CHANGE_FAILED");
  return result.data;
};

/**
 * Reads the exact #566 policy snapshot and live readiness projection from its
 * Record-owned repository.  The stored procedure locks the target policy,
 * limits, binding and archive readiness facts while this request activates the
 * installation; Module never reads Record tables directly.
 */
const requireExecutableLifecyclePolicies = async (
  transaction: RequestDatabaseTransaction,
  command: ApplicationInstallationActivationCommand,
): Promise<void> => {
  const rows = await transaction.query<LifecyclePolicyReadinessRow>`
    select vortex_record.read_application_lifecycle_policy_readiness(
      ${command.applicationRootId}::uuid,
      ${command.applicationReleaseRevision}::bigint,
      ${JSON.stringify(command.expectedModuleBindings)}::jsonb
    ) as lifecycle_readiness
  `;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new ApplicationInstallationLifecycleError(
      "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE",
    );
  const readiness = applicationLifecyclePolicyReadinessSchema.safeParse(
    rows[0].lifecycle_readiness,
  );
  if (!readiness.success || readiness.data.organizationLimits.organizationId !== readiness.data.organizationId)
    throw new ApplicationInstallationLifecycleError(
      "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE",
    );

  for (const policy of readiness.data.policies) {
    if (
      policy.organizationId !== readiness.data.organizationId ||
      (policy.applicationRootId !== readiness.data.applicationRootId &&
        policy.applicationRootId !== null) ||
      !validateRecordTypeLifecyclePolicy(
        policy,
        readiness.data.organizationLimits,
        readiness.data.readinessEvidence,
        readiness.data.organizationLimits.settingsRevision,
      ).valid
    )
      throw new ApplicationInstallationLifecycleError(
        "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE",
      );
  }
};

export interface ApplicationInstallationLifecycleRepository {
  activate(
    command: ApplicationInstallationActivationCommand,
  ): Promise<ApplicationInstallationLifecycleResult>;
  detach(
    command: ApplicationInstallationDetachCommand,
  ): Promise<ApplicationInstallationLifecycleResult>;
}

/** Calls only the two fixed Application-wide lifecycle operations. */
export const createApplicationInstallationLifecycleRepository = (
  transaction: RequestDatabaseTransaction,
): ApplicationInstallationLifecycleRepository =>
  Object.freeze({
    async activate(commandCandidate: ApplicationInstallationActivationCommand) {
      const command = applicationInstallationActivationCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new ApplicationInstallationLifecycleError(
          "INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND",
        );
      try {
        await requireExecutableLifecyclePolicies(transaction, command.data);
        return parseResult(
          await transaction.query<LifecycleRow>`
            select vortex_module.activate_application_installation(
              ${command.data.applicationRootId}::uuid,
              ${command.data.applicationReleaseRevision}::bigint,
              ${JSON.stringify(command.data.expectedModuleBindings)}::jsonb
            ) as lifecycle_result
          `,
        );
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async detach(commandCandidate: ApplicationInstallationDetachCommand) {
      const command = applicationInstallationDetachCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new ApplicationInstallationLifecycleError(
          "INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND",
        );
      try {
        return parseResult(
          await transaction.query<LifecycleRow>`
            select vortex_module.detach_application_installation(
              ${command.data.applicationRootId}::uuid,
              ${command.data.applicationReleaseRevision}::bigint,
              ${JSON.stringify(command.data.expectedModuleBindings)}::jsonb
            ) as lifecycle_result
          `,
        );
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
