import "server-only";

import { identitySessionSchema, type IdentitySession } from "../access/identity-access";
import {
  databaseCode,
  databaseTimestamp,
  databaseRevision,
  describeFailure,
} from "../catalogue/runtime-primitives";
import {
  createTenantOrganizationCommandSchema,
  createTenantOrganizationResultSchema,
  reactivateTenantOrganizationCommandSchema,
  reactivateTenantOrganizationResultSchema,
  renameTenantOrganizationCommandSchema,
  renameTenantOrganizationResultSchema,
  reparentTenantOrganizationCommandSchema,
  reparentTenantOrganizationResultSchema,
  suspendTenantOrganizationCommandSchema,
  suspendTenantOrganizationResultSchema,
  type CreateTenantOrganizationCommand,
  type CreateTenantOrganizationResult,
  type ReactivateTenantOrganizationCommand,
  type ReactivateTenantOrganizationResult,
  type RenameTenantOrganizationCommand,
  type RenameTenantOrganizationResult,
  type ReparentTenantOrganizationCommand,
  type ReparentTenantOrganizationResult,
  type SuspendTenantOrganizationCommand,
  type SuspendTenantOrganizationResult,
} from "./tenant-governance";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "../db/request-transaction";
import { logRefusedOperations } from "./log-refused-operations";

type Runner = <Result>(
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;
/**
 * Every tenant command reads its acting person from the transaction's bound request context
 * (`vortex_identity.tenant_request_actor_id()`), never from `session`. A transaction with no bound
 * human or federated context, such as the default runtime transaction, is refused.
 */
type TenantGovernanceServiceDependencies = Readonly<{ runtimeTransaction?: Runner }>;

type OrganizationMutationRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
type OrganizationCreationRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  organization_id: unknown;
  organization_revision: unknown;
  organization_account_id: unknown;
  organization_account_revision: unknown;
  access_version: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
// A poisoned request-bound transaction is logged once by the request boundary that aborts on it.
export const transactionPoisonErrorName = "TenantGovernanceTransactionPoisoned";
const mutationCode = (error: unknown) => {
  // The database cause is logged where it is mapped to the safe code the caller receives.
  if (!(error instanceof Error && error.name === transactionPoisonErrorName))
    console.error(`[identity] tenant governance operation refused: ${describeFailure(error)}`);
  switch (databaseCode(error)) {
    case "V3001":
      return "duplicate_conflict" as const;
    case "V3102":
      return "stale_revision" as const;
    case "V3152":
      return "multi_factor_required" as const;
    case "V3103":
      return "last_manager" as const;
    case "V3101":
    case "42501":
    case "23503":
    case "23505":
    case "23514":
    case "40001":
      return "unavailable" as const;
    case "22023":
      return "invalid_command" as const;
    default:
      return "operation_unavailable" as const;
  }
};
const organizationMutationCode = (error: unknown) => {
  const code = mutationCode(error);
  return code === "last_manager" ? ("unavailable" as const) : code;
};
const organizationMutationResult = (row: OrganizationMutationRow | undefined) =>
  row && {
    outcome: row.outcome,
    operation: row.operation,
    organizationId: row.organization_id,
    revision: databaseRevision(row.revision),
    correlationId: row.correlation_id,
    acceptedAt: databaseTimestamp(row.accepted_at),
  };
const organizationCreationResult = (row: OrganizationCreationRow | undefined) =>
  row && {
    outcome: row.outcome,
    operation: row.operation,
    organizationId: row.organization_id,
    organizationRevision: databaseRevision(row.organization_revision),
    organizationAccountId: row.organization_account_id,
    organizationAccountRevision: databaseRevision(row.organization_account_revision),
    accessVersion: databaseRevision(row.access_version),
    correlationId: row.correlation_id,
    acceptedAt: databaseTimestamp(row.accepted_at),
  };

export const createTenantGovernanceService = (
  dependencies: TenantGovernanceServiceDependencies = {},
) => {
  const run = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const sessionIdentity = (session: IdentitySession) => identitySessionSchema.safeParse(session);
  const operations = {
    async createOrganization(
      session: IdentitySession,
      candidate: CreateTenantOrganizationCommand,
    ): Promise<CreateTenantOrganizationResult> {
      const verified = sessionIdentity(session);
      const command = createTenantOrganizationCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "create_tenant_organization",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const steward = value.organizationSteward;
        const settings = value.runtimeSettings;
        const rows = await run(
          (tx) =>
            tx.query<OrganizationCreationRow>`select * from vortex_identity.create_tenant_organization(${value.duplicateKey}::uuid, ${value.tenantId}::uuid, ${value.parentOrganizationId}::uuid, ${value.shortName}::text, ${value.displayName}::text, ${steward.identityId}::uuid, ${steward.accountDisplayName}::text, ${steward.accountLanguage}::text, ${steward.accountTimeZone}::text, ${settings.language}::text, ${settings.timeZone}::text, ${settings.currency}::text, ${settings.dateFormat}::text, ${settings.numberFormat}::text)`,
        );
        return createTenantOrganizationResultSchema.parse(
          organizationCreationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "create_tenant_organization",
          code: organizationMutationCode(error),
        };
      }
    },
    async renameOrganization(
      session: IdentitySession,
      candidate: RenameTenantOrganizationCommand,
    ): Promise<RenameTenantOrganizationResult> {
      const verified = sessionIdentity(session);
      const command = renameTenantOrganizationCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "rename_tenant_organization",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const rows = await run(
          (tx) =>
            tx.query<OrganizationMutationRow>`select * from vortex_identity.rename_tenant_organization(${value.duplicateKey}::uuid, ${value.tenantId}::uuid, ${value.organizationId}::uuid, ${value.expectedRevision}::bigint, ${value.displayName}::text)`,
        );
        return renameTenantOrganizationResultSchema.parse(
          organizationMutationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "rename_tenant_organization",
          code: organizationMutationCode(error),
        };
      }
    },
    async reparentOrganization(
      session: IdentitySession,
      candidate: ReparentTenantOrganizationCommand,
    ): Promise<ReparentTenantOrganizationResult> {
      const verified = sessionIdentity(session);
      const command = reparentTenantOrganizationCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "reparent_tenant_organization",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const rows = await run(
          (tx) =>
            tx.query<OrganizationMutationRow>`select * from vortex_identity.reparent_tenant_organization(${value.duplicateKey}::uuid, ${value.tenantId}::uuid, ${value.organizationId}::uuid, ${value.expectedRevision}::bigint, ${value.parentOrganizationId}::uuid)`,
        );
        return reparentTenantOrganizationResultSchema.parse(
          organizationMutationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "reparent_tenant_organization",
          code: organizationMutationCode(error),
        };
      }
    },
    async suspendOrganization(
      session: IdentitySession,
      candidate: SuspendTenantOrganizationCommand,
    ): Promise<SuspendTenantOrganizationResult> {
      const verified = sessionIdentity(session);
      const command = suspendTenantOrganizationCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "suspend_tenant_organization",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const rows = await run(
          (tx) =>
            tx.query<OrganizationMutationRow>`select * from vortex_identity.suspend_tenant_organization(${value.duplicateKey}::uuid, ${value.tenantId}::uuid, ${value.organizationId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return suspendTenantOrganizationResultSchema.parse(
          organizationMutationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "suspend_tenant_organization",
          code: organizationMutationCode(error),
        };
      }
    },
    async reactivateOrganization(
      session: IdentitySession,
      candidate: ReactivateTenantOrganizationCommand,
    ): Promise<ReactivateTenantOrganizationResult> {
      const verified = sessionIdentity(session);
      const command = reactivateTenantOrganizationCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "reactivate_tenant_organization",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const rows = await run(
          (tx) =>
            tx.query<OrganizationMutationRow>`select * from vortex_identity.reactivate_tenant_organization(${value.duplicateKey}::uuid, ${value.tenantId}::uuid, ${value.organizationId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return reactivateTenantOrganizationResultSchema.parse(
          organizationMutationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "reactivate_tenant_organization",
          code: organizationMutationCode(error),
        };
      }
    },
  };

  return Object.freeze(logRefusedOperations("TENANT_GOVERNANCE", operations));
};
