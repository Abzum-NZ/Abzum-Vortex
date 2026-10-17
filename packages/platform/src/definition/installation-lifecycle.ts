import "server-only";

import {
  sameId,
  applicationInstallationActivationCommandSchema,
  applicationInstallationDetachCommandSchema,
  applicationInstallationLifecycleResultSchema,
  applicationLifecyclePolicyReadinessSchema,
  indexReadinessSchema,
  validateRecordTypeLifecyclePolicy,
  type ApplicationInstallationActivationCommand,
  type ApplicationInstallationDetachCommand,
  type ApplicationInstallationLifecycleErrorCode,
  type ApplicationInstallationLifecycleResult,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

type LifecycleRow = DatabaseRow & { readonly lifecycle_result: unknown };
type StoredPoliciesRow = DatabaseRow & { readonly stored_policies: unknown };
type LifecyclePolicyReadinessRow = DatabaseRow & { readonly lifecycle_readiness: unknown };
type IndexReadinessRow = DatabaseRow & { readonly index_readiness: unknown };

const mapFailure = (error: unknown): DefinitionError<ApplicationInstallationLifecycleErrorCode> => {
  if (error instanceof DefinitionError) return error;
  // The database refusal stays the cause, so the server log names the check that refused.
  const cause = { cause: error };
  switch (classifyDatabaseError(error)) {
    case "invalid":
      return new DefinitionError("INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND", cause);
    case "refused":
      return new DefinitionError("APPLICATION_INSTALLATION_AUTHORITY_REFUSED", cause);
    case "not_found":
      return new DefinitionError("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", cause);
    case "conflict":
      return new DefinitionError("APPLICATION_INSTALLATION_BINDING_CONFLICT", cause);
    case "constraint_failed":
    case "wrong_state":
      return new DefinitionError("APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE", cause);
    default:
      return unexpectedDefinitionFailure(
        "APPLICATION_INSTALLATION_CHANGE_FAILED",
        error,
        "installation-lifecycle",
      );
  }
};

const parseResult = (rows: readonly LifecycleRow[]): ApplicationInstallationLifecycleResult => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new DefinitionError("APPLICATION_INSTALLATION_CHANGE_FAILED");
  const result = applicationInstallationLifecycleResultSchema.safeParse(rows[0].lifecycle_result);
  if (!result.success)
    throw unexpectedDefinitionFailure(
      "APPLICATION_INSTALLATION_CHANGE_FAILED",
      result.error,
      "installation-lifecycle",
    );
  return result.data;
};

const bindingsIncomplete = (): DefinitionError<ApplicationInstallationLifecycleErrorCode> =>
  new DefinitionError("APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE");

/**
 * The one installation step that gives every record type of the activated release its lifecycle
 * policy. A record type without a stored policy gets the platform default (see
 * `vortex_record.ensure_application_lifecycle_policies`); a stored policy is never changed. First
 * install and upgrade both reach it here, inside the activation transaction and after the binding
 * locks, so the executable-policy gate that follows always reads a complete set.
 */
const ensureLifecyclePolicies = async (
  transaction: RequestDatabaseTransaction,
  command: ApplicationInstallationActivationCommand,
  activated: ApplicationInstallationLifecycleResult,
): Promise<void> => {
  if (
    activated.state !== "active" ||
    !sameId(activated.applicationRootId, command.applicationRootId) ||
    activated.applicationReleaseRevision !== command.applicationReleaseRevision
  )
    throw bindingsIncomplete();
  const rows = await transaction.query<StoredPoliciesRow>`
    select vortex_record.ensure_application_lifecycle_policies(
      ${activated.organizationId}::uuid,
      ${command.applicationRootId}::uuid,
      ${command.applicationReleaseRevision}::bigint,
      ${JSON.stringify(activatedBindings(activated))}::text::jsonb
    ) as stored_policies
  `;
  const stored = rows[0]?.stored_policies;
  if (rows.length !== 1 || typeof stored !== "number" || !Number.isSafeInteger(stored) || stored < 0)
    throw unexpectedDefinitionFailure(
      "APPLICATION_INSTALLATION_CHANGE_FAILED",
      new Error(`lifecycle policy step returned ${rows.length} rows`),
      "installation-lifecycle",
    );
};

/**
 * The readiness gates run after the activation flipped the binding set, which advances every
 * binding revision, so they name the activated bindings, not the pre-activation revisions the
 * command expected.
 */
const activatedBindings = (activated: ApplicationInstallationLifecycleResult) =>
  activated.moduleBindings.map((binding) => ({
    moduleRootId: binding.moduleRootId,
    bindingRevision: binding.bindingRevision,
  }));

/**
 * Refuses the activation unless every record type the installation owns has a
 * current, executable stored lifecycle policy.
 *
 * It runs immediately after `vortex_definition.activate_application_installation`
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
    !sameId(activated.applicationRootId, command.applicationRootId) ||
    activated.applicationReleaseRevision !== command.applicationReleaseRevision
  )
    throw bindingsIncomplete();

  const rows = await transaction.query<LifecyclePolicyReadinessRow>`
    select vortex_record.read_application_lifecycle_policy_readiness(
      ${activated.organizationId}::uuid,
      ${command.applicationRootId}::uuid,
      ${command.applicationReleaseRevision}::bigint,
      ${JSON.stringify(activatedBindings(activated))}::text::jsonb
    ) as lifecycle_readiness
  `;
  if (rows.length !== 1 || rows[0] === undefined) throw bindingsIncomplete();

  const readiness = applicationLifecyclePolicyReadinessSchema.safeParse(
    rows[0].lifecycle_readiness,
  );
  if (
    !readiness.success ||
    !sameId(readiness.data.organizationId, activated.organizationId) ||
    !sameId(readiness.data.applicationRootId, activated.applicationRootId) ||
    !sameId(readiness.data.organizationLimits.organizationId, readiness.data.organizationId) ||
    !sameId(readiness.data.readinessEvidence.organizationId, readiness.data.organizationId)
  )
    throw bindingsIncomplete();

  for (const policy of readiness.data.policies) {
    // An organisation-shared record type carries no application root; an
    // application-contained one must carry exactly this Application.
    const scopedToThisInstallation =
      policy.applicationRootId === null ||
      sameId(policy.applicationRootId, readiness.data.applicationRootId);
    if (
      !sameId(policy.organizationId, readiness.data.organizationId) ||
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

/**
 * Refuses the activation unless every uniqueness field index the installation
 * owns is observed-ready for its exact desired definition and lineage.
 *
 * Performance indexes are advisory: a missing or invalid one never blocks
 * activation, because it cannot remove supported behaviour. A required
 * uniqueness index that is missing, invalid or recorded against a different
 * desired definition does block, so an installation can never activate early
 * without the uniqueness the published definition promises.
 *
 * It runs in the same request transaction as the activation write, after the
 * lifecycle-policy gate and the canonical binding locks, and reads only the
 * Record-owned projection. Module never reads Record tables or catalog state.
 */
const requireReadyUniquenessIndexes = async (
  transaction: RequestDatabaseTransaction,
  command: ApplicationInstallationActivationCommand,
  activated: ApplicationInstallationLifecycleResult,
): Promise<void> => {
  // The gate is only meaningful against the exact installation this command
  // activated; anything else is an unusable result rather than a pass.
  if (
    activated.state !== "active" ||
    !sameId(activated.applicationRootId, command.applicationRootId) ||
    activated.applicationReleaseRevision !== command.applicationReleaseRevision
  )
    throw bindingsIncomplete();

  const rows = await transaction.query<IndexReadinessRow>`
    select vortex_record.read_index_readiness(
      ${activated.organizationId}::uuid,
      ${command.applicationRootId}::uuid,
      ${command.applicationReleaseRevision}::bigint,
      ${JSON.stringify(activatedBindings(activated))}::text::jsonb
    ) as index_readiness
  `;
  if (rows.length !== 1 || rows[0] === undefined) throw bindingsIncomplete();

  const readiness = indexReadinessSchema.safeParse(rows[0].index_readiness);
  if (
    !readiness.success ||
    !sameId(readiness.data.organizationId, activated.organizationId) ||
    !sameId(readiness.data.applicationRootId, activated.applicationRootId) ||
    readiness.data.applicationReleaseRevision !== command.applicationReleaseRevision
  )
    throw bindingsIncomplete();

  for (const entry of readiness.data.indexes) {
    // Performance indexes are advisory: they never refuse activation. Only a
    // required uniqueness index that is not observed ready does.
    if (entry.purpose !== "uniqueness") continue;
    if (!entry.ready || entry.observedState !== "present") throw bindingsIncomplete();
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
        throw new DefinitionError("INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND");
      try {
        const activated = parseResult(
          await transaction.query<LifecycleRow>`
            select vortex_definition.activate_application_installation(
              ${command.data.applicationRootId}::uuid,
              ${command.data.applicationReleaseRevision}::bigint,
              ${JSON.stringify(command.data.expectedModuleBindings)}::text::jsonb
            ) as lifecycle_result
          `,
        );
        await ensureLifecyclePolicies(transaction, command.data, activated);
        await requireExecutableLifecyclePolicies(transaction, command.data, activated);
        await requireReadyUniquenessIndexes(transaction, command.data, activated);
        return activated;
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async detach(commandCandidate: ApplicationInstallationDetachCommand) {
      const command = applicationInstallationDetachCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new DefinitionError("INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND");
      try {
        return parseResult(
          await transaction.query<LifecycleRow>`
            select vortex_definition.detach_application_installation(
              ${command.data.applicationRootId}::uuid,
              ${command.data.applicationReleaseRevision}::bigint,
              ${JSON.stringify(command.data.expectedModuleBindings)}::text::jsonb
            ) as lifecycle_result
          `,
        );
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
