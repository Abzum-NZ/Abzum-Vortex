import "server-only";

import { createHash } from "node:crypto";
import {
  adoptOrganizationCommandSchema,
  adoptOrganizationResultSchema,
  adoptTenantCommandSchema,
  adoptTenantResultSchema,
  closeClusterIdentityCommandSchema,
  closeClusterIdentityResultSchema,
  configuredTenantAdministrationOperatorContextSchema,
  provisionTenantCommandSchema,
  provisionTenantResultSchema,
  reactivateClusterIdentityCommandSchema,
  reactivateClusterIdentityResultSchema,
  reactivateTenantCommandSchema,
  reactivateTenantResultSchema,
  suspendClusterIdentityCommandSchema,
  suspendClusterIdentityResultSchema,
  suspendTenantCommandSchema,
  suspendTenantResultSchema,
  type AdoptOrganizationCommand,
  type AdoptOrganizationResult,
  type AdoptTenantCommand,
  type AdoptTenantResult,
  type CloseClusterIdentityCommand,
  type CloseClusterIdentityResult,
  type ConfiguredTenantAdministrationOperatorContext,
  type ProvisionTenantCommand,
  type ProvisionTenantResult,
  type ReactivateClusterIdentityCommand,
  type ReactivateClusterIdentityResult,
  type ReactivateTenantCommand,
  type ReactivateTenantResult,
  type SuspendClusterIdentityCommand,
  type SuspendClusterIdentityResult,
  type SuspendTenantCommand,
  type SuspendTenantResult,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface ConfiguredTenantAdministrationDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

type ProvisionRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  tenant_id: unknown;
  root_organization_id: unknown;
  tenant_administrator_assignment_id: unknown;
  tenant_administrator_assignment_revision: unknown;
  organization_account_id: unknown;
  organization_account_revision: unknown;
  access_version: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
type AdoptTenantRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  tenant_id: unknown;
  tenant_administrator_assignment_id: unknown;
  tenant_administrator_assignment_revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
type AdoptOrganizationRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  tenant_id: unknown;
  organization_id: unknown;
  organization_account_id: unknown;
  access_version: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
type ClusterIdentityLifecycleRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  identity_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
type TenantLifecycleRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  tenant_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;
const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};
const fingerprint = (command: object): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(command), "utf8").digest("hex")}`;
const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const configuredContext = (
  environment: Readonly<Record<string, string | undefined>>,
): ConfiguredTenantAdministrationOperatorContext | undefined => {
  const parsed = configuredTenantAdministrationOperatorContextSchema.safeParse({
    kind: "configured_system_operator",
    clusterId: environment.VORTEX_CLUSTER_ID,
    systemActorId: environment.VORTEX_TENANT_ADMINISTRATION_OPERATOR_ACTOR_ID,
  });
  return parsed.success ? parsed.data : undefined;
};

const refusalCode = (error: unknown) => {
  switch (databaseCode(error)) {
    case "V3001":
      return "duplicate_conflict" as const;
    case "V3002":
      return "steward_unavailable" as const;
    case "V3003":
    case "42501":
    case "23503":
    case "23505":
    case "23514":
    case "40001":
    case "55000":
      return "scope_unavailable" as const;
    case "22023":
      return "invalid_command" as const;
    default:
      return "operation_unavailable" as const;
  }
};
const lifecycleRefusalCode = (error: unknown) =>
  databaseCode(error) === "V3102" ? ("stale_revision" as const) : refusalCode(error);

const one = <Row extends DatabaseRow>(rows: readonly Row[]): Row | undefined =>
  rows.length === 1 ? rows[0] : undefined;

export const createConfiguredTenantAdministrationService = (
  dependencies: ConfiguredTenantAdministrationDependencies = {},
) => {
  const operator = configuredContext(dependencies.environment ?? process.env);
  const run = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  const lifecycleResult = (row: ClusterIdentityLifecycleRow | undefined) =>
    row && {
      outcome: row.outcome,
      operation: row.operation,
      identityId: row.identity_id,
      revision: revision(row.revision),
      correlationId: row.correlation_id,
      acceptedAt: timestamp(row.accepted_at),
    };
  const tenantLifecycleResult = (row: TenantLifecycleRow | undefined) =>
    row && {
      outcome: row.outcome,
      operation: row.operation,
      tenantId: row.tenant_id,
      revision: revision(row.revision),
      correlationId: row.correlation_id,
      acceptedAt: timestamp(row.accepted_at),
    };

  return Object.freeze({
    async provisionTenant(candidate: ProvisionTenantCommand): Promise<ProvisionTenantResult> {
      const command = provisionTenantCommandSchema.safeParse(candidate);
      if (!command.success)
        return { outcome: "refused", operation: "provision_tenant", code: "invalid_command" };
      if (!operator)
        return {
          outcome: "refused",
          operation: "provision_tenant",
          code: "operator_not_configured",
        };
      try {
        return await run(async (transaction) => {
          const value = command.data;
          const rows = await transaction.query<ProvisionRow>`
            select * from vortex_identity.provision_tenant(
              ${operator.clusterId}::uuid,
              ${operator.systemActorId}::uuid,
              ${value.duplicateKey}::uuid,
              ${fingerprint(value)}::text,
              ${value.tenant.shortName}::text,
              ${value.tenant.displayName}::text,
              ${value.rootOrganization.shortName}::text,
              ${value.rootOrganization.displayName}::text,
              ${value.tenantSteward.identityId}::uuid,
              ${value.organizationSteward.identityId}::uuid,
              ${value.organizationSteward.accountDisplayName}::text,
              ${value.organizationSteward.accountLanguage}::text,
              ${value.organizationSteward.accountTimeZone}::text,
              ${value.runtimeSettings.language}::text,
              ${value.runtimeSettings.timeZone}::text,
              ${value.runtimeSettings.currency}::text,
              ${value.runtimeSettings.dateFormat}::text,
              ${value.runtimeSettings.numberFormat}::text
            )
          `;
          const row = one(rows);
          const parsed = provisionTenantResultSchema.safeParse(
            row && {
              outcome: row.outcome,
              operation: row.operation,
              tenantId: row.tenant_id,
              rootOrganizationId: row.root_organization_id,
              tenantAdministratorAssignmentId: row.tenant_administrator_assignment_id,
              tenantAdministratorAssignmentRevision: revision(
                row.tenant_administrator_assignment_revision,
              ),
              organizationAccountId: row.organization_account_id,
              organizationAccountRevision: revision(row.organization_account_revision),
              accessVersion: revision(row.access_version),
              correlationId: row.correlation_id,
              acceptedAt: timestamp(row.accepted_at),
            },
          );
          if (!parsed.success) throw new Error("Configured provisioning result contract mismatch");
          return parsed.data;
        });
      } catch (error) {
        return { outcome: "refused", operation: "provision_tenant", code: refusalCode(error) };
      }
    },

    async adoptTenant(candidate: AdoptTenantCommand): Promise<AdoptTenantResult> {
      const command = adoptTenantCommandSchema.safeParse(candidate);
      if (!command.success)
        return { outcome: "refused", operation: "adopt_tenant", code: "invalid_command" };
      if (!operator)
        return {
          outcome: "refused",
          operation: "adopt_tenant",
          code: "operator_not_configured",
        };
      try {
        return await run(async (transaction) => {
          const value = command.data;
          const rows = await transaction.query<AdoptTenantRow>`
            select * from vortex_identity.adopt_tenant(
              ${operator.systemActorId}::uuid,
              ${value.duplicateKey}::uuid,
              ${fingerprint(value)}::text,
              ${value.tenantId}::uuid,
              ${value.tenantSteward.identityId}::uuid
            )
          `;
          const row = one(rows);
          const parsed = adoptTenantResultSchema.safeParse(
            row && {
              outcome: row.outcome,
              operation: row.operation,
              tenantId: row.tenant_id,
              tenantAdministratorAssignmentId: row.tenant_administrator_assignment_id,
              tenantAdministratorAssignmentRevision: revision(
                row.tenant_administrator_assignment_revision,
              ),
              correlationId: row.correlation_id,
              acceptedAt: timestamp(row.accepted_at),
            },
          );
          if (!parsed.success)
            throw new Error("Configured tenant adoption result contract mismatch");
          return parsed.data;
        });
      } catch (error) {
        return { outcome: "refused", operation: "adopt_tenant", code: refusalCode(error) };
      }
    },

    async adoptOrganization(candidate: AdoptOrganizationCommand): Promise<AdoptOrganizationResult> {
      const command = adoptOrganizationCommandSchema.safeParse(candidate);
      if (!command.success)
        return { outcome: "refused", operation: "adopt_organization", code: "invalid_command" };
      if (!operator)
        return {
          outcome: "refused",
          operation: "adopt_organization",
          code: "operator_not_configured",
        };
      try {
        return await run(async (transaction) => {
          const value = command.data;
          const rows = await transaction.query<AdoptOrganizationRow>`
            select * from vortex_identity.adopt_organization(
              ${operator.systemActorId}::uuid,
              ${value.duplicateKey}::uuid,
              ${fingerprint(value)}::text,
              ${value.tenantId}::uuid,
              ${value.organizationId}::uuid,
              ${value.organizationSteward.identityId}::uuid,
              ${value.organizationSteward.organizationAccountId}::uuid
            )
          `;
          const row = one(rows);
          const parsed = adoptOrganizationResultSchema.safeParse(
            row && {
              outcome: row.outcome,
              operation: row.operation,
              tenantId: row.tenant_id,
              organizationId: row.organization_id,
              organizationAccountId: row.organization_account_id,
              accessVersion: revision(row.access_version),
              correlationId: row.correlation_id,
              acceptedAt: timestamp(row.accepted_at),
            },
          );
          if (!parsed.success)
            throw new Error("Configured organization adoption result contract mismatch");
          return parsed.data;
        });
      } catch (error) {
        return { outcome: "refused", operation: "adopt_organization", code: refusalCode(error) };
      }
    },

    async suspendClusterIdentity(
      candidate: SuspendClusterIdentityCommand,
    ): Promise<SuspendClusterIdentityResult> {
      const command = suspendClusterIdentityCommandSchema.safeParse(candidate);
      if (!command.success)
        return {
          outcome: "refused",
          operation: "suspend_cluster_identity",
          code: "invalid_command",
        };
      if (!operator)
        return {
          outcome: "refused",
          operation: "suspend_cluster_identity",
          code: "operator_not_configured",
        };
      try {
        const value = command.data;
        const rows = await run(
          (transaction) =>
            transaction.query<ClusterIdentityLifecycleRow>`select * from vortex_identity.suspend_cluster_identity(${operator.clusterId}::uuid, ${operator.systemActorId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.identityId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return suspendClusterIdentityResultSchema.parse(lifecycleResult(one(rows)));
      } catch (error) {
        return {
          outcome: "refused",
          operation: "suspend_cluster_identity",
          code: lifecycleRefusalCode(error),
        };
      }
    },

    async reactivateClusterIdentity(
      candidate: ReactivateClusterIdentityCommand,
    ): Promise<ReactivateClusterIdentityResult> {
      const command = reactivateClusterIdentityCommandSchema.safeParse(candidate);
      if (!command.success)
        return {
          outcome: "refused",
          operation: "reactivate_cluster_identity",
          code: "invalid_command",
        };
      if (!operator)
        return {
          outcome: "refused",
          operation: "reactivate_cluster_identity",
          code: "operator_not_configured",
        };
      try {
        const value = command.data;
        const rows = await run(
          (transaction) =>
            transaction.query<ClusterIdentityLifecycleRow>`select * from vortex_identity.reactivate_cluster_identity(${operator.clusterId}::uuid, ${operator.systemActorId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.identityId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return reactivateClusterIdentityResultSchema.parse(lifecycleResult(one(rows)));
      } catch (error) {
        return {
          outcome: "refused",
          operation: "reactivate_cluster_identity",
          code: lifecycleRefusalCode(error),
        };
      }
    },

    async closeClusterIdentity(
      candidate: CloseClusterIdentityCommand,
    ): Promise<CloseClusterIdentityResult> {
      const command = closeClusterIdentityCommandSchema.safeParse(candidate);
      if (!command.success)
        return { outcome: "refused", operation: "close_cluster_identity", code: "invalid_command" };
      if (!operator)
        return {
          outcome: "refused",
          operation: "close_cluster_identity",
          code: "operator_not_configured",
        };
      try {
        const value = command.data;
        const rows = await run(
          (transaction) =>
            transaction.query<ClusterIdentityLifecycleRow>`select * from vortex_identity.close_cluster_identity(${operator.clusterId}::uuid, ${operator.systemActorId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.identityId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return closeClusterIdentityResultSchema.parse(lifecycleResult(one(rows)));
      } catch (error) {
        return {
          outcome: "refused",
          operation: "close_cluster_identity",
          code: lifecycleRefusalCode(error),
        };
      }
    },

    async suspendTenant(candidate: SuspendTenantCommand): Promise<SuspendTenantResult> {
      const command = suspendTenantCommandSchema.safeParse(candidate);
      if (!command.success)
        return { outcome: "refused", operation: "suspend_tenant", code: "invalid_command" };
      if (!operator)
        return {
          outcome: "refused",
          operation: "suspend_tenant",
          code: "operator_not_configured",
        };
      try {
        const value = command.data;
        const rows = await run(
          (transaction) =>
            transaction.query<TenantLifecycleRow>`select * from vortex_identity.suspend_tenant(${operator.clusterId}::uuid, ${operator.systemActorId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.tenantId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return suspendTenantResultSchema.parse(tenantLifecycleResult(one(rows)));
      } catch (error) {
        return {
          outcome: "refused",
          operation: "suspend_tenant",
          code: lifecycleRefusalCode(error),
        };
      }
    },

    async reactivateTenant(candidate: ReactivateTenantCommand): Promise<ReactivateTenantResult> {
      const command = reactivateTenantCommandSchema.safeParse(candidate);
      if (!command.success)
        return { outcome: "refused", operation: "reactivate_tenant", code: "invalid_command" };
      if (!operator)
        return {
          outcome: "refused",
          operation: "reactivate_tenant",
          code: "operator_not_configured",
        };
      try {
        const value = command.data;
        const rows = await run(
          (transaction) =>
            transaction.query<TenantLifecycleRow>`select * from vortex_identity.reactivate_tenant(${operator.clusterId}::uuid, ${operator.systemActorId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.tenantId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return reactivateTenantResultSchema.parse(tenantLifecycleResult(one(rows)));
      } catch (error) {
        return {
          outcome: "refused",
          operation: "reactivate_tenant",
          code: lifecycleRefusalCode(error),
        };
      }
    },
  });
};

const defaultService = createConfiguredTenantAdministrationService();
export const provisionTenant = defaultService.provisionTenant;
export const adoptTenant = defaultService.adoptTenant;
export const adoptOrganization = defaultService.adoptOrganization;
export const suspendClusterIdentity = defaultService.suspendClusterIdentity;
export const reactivateClusterIdentity = defaultService.reactivateClusterIdentity;
export const closeClusterIdentity = defaultService.closeClusterIdentity;
export const suspendTenant = defaultService.suspendTenant;
export const reactivateTenant = defaultService.reactivateTenant;
