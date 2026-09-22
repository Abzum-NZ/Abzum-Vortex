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

const sameIdentifier = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const bindingsIncomplete = (): ApplicationInstallationLifecycleError =>
  new ApplicationInstallationLifecycleError("APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE");

/**
 * Refuses the activation unless every record type the installation owns has a
 * current, executable stored lifecycle policy.
 *
 * It runs immediately after `vortex_module.activate_application_installation`
 * and inside the same request transaction, so the binding rows are already
 * held exclusively by this transaction under that operation's canonical
 * advisory-lock order and the human authority behind the activation has
 * already been validated and pinned to its organisation Access version. That
 * ordering is deliberate: reading the policies first would take a shared lock
 * on rows the activation then has to upgrade, which is the classic
 * lock-upgrade deadlock between two concurrent activations. A refusal here
 * throws, so the activation write it gates is rolled back with it.
 *
 * Module never reads Record tables: the Record-owned procedure locks the
 * target policies, organisation ceilings and archive readiness facts and
 * returns only this projection.
 */
const requireExecutableLifecyclePolicies = async (
  transaction: RequestDatabaseTransaction,
  command: ApplicationInstallationActivationCommand,
  activated: ApplicationInstallationLifecycleResult,
): Promise<void> => {
  // The gate is only meaningful against the exact installation this command
  // activated; anything else is an unusable result rather than a pass.
  if (
    activated.state !== "active" ||
    !sameIdentifier(activated.applicationRootId, command.applicationRootId) ||
    activated.applicationReleaseRevision !== command.applicationReleaseRevision
  )
    throw bindingsIncomplete();

  const rows = await transaction.query<LifecyclePolicyReadinessRow>`
    select vortex_record.read_application_lifecycle_policy_readiness(
      ${activated.organizationId}::uuid,
      ${command.applicationRootId}::uuid,
      ${command.applicationReleaseRevision}::bigint,
      ${JSON.stringify(command.expectedModuleBindings)}::jsonb
    ) as lifecycle_readiness
  `;
  if (rows.length !== 1 || rows[0] === undefined) throw bindingsIncomplete();

  const readiness = applicationLifecyclePolicyReadinessSchema.safeParse(
    rows[0].lifecycle_readiness,
  );
  if (
    !readiness.success ||
    !sameIdentifier(readiness.data.organizationId, activated.organizationId) ||
    !sameIdentifier(readiness.data.applicationRootId, activated.applicationRootId) ||
    !sameIdentifier(
      readiness.data.organizationLimits.organizationId,
      readiness.data.organizationId,
    ) ||
    !sameIdentifier(readiness.data.readinessEvidence.organizationId, readiness.data.organizationId)
  )
    throw bindingsIncomplete();

  for (const policy of readiness.data.policies) {
    // An organisation-shared record type carries no application root; an
    // application-contained one must carry exactly this Application.
    const scopedToThisInstallation =
      policy.applicationRootId === null ||
      sameIdentifier(policy.applicationRootId, readiness.data.applicationRootId);
    if (
      !sameIdentifier(policy.organizationId, readiness.data.organizationId) ||
      !scopedToThisInstallation ||
      // The ceilings were read and locked in the same transaction as the
      // policies, so the revision they carry is the revision this validation
      // is bound to.
      !validateRecordTypeLifecyclePolicy(
        policy,
        readiness.data.organizationLimits,
        readiness.data.readinessEvidence,
        readiness.data.organizationLimits.settingsRevision,
      ).valid
    )
      throw bindingsIncomplete();
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
        const activated = parseResult(
          await transaction.query<LifecycleRow>`
            select vortex_module.activate_application_installation(
              ${command.data.applicationRootId}::uuid,
              ${command.data.applicationReleaseRevision}::bigint,
              ${JSON.stringify(command.data.expectedModuleBindings)}::jsonb
            ) as lifecycle_result
          `,
        );
        await requireExecutableLifecyclePolicies(transaction, command.data, activated);
        return activated;
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
