import "server-only";

import { createHash } from "node:crypto";
import {
  adoptOrganizationCommandSchema,
  adoptOrganizationResultSchema,
  adoptTenantCommandSchema,
  adoptTenantResultSchema,
  configuredTenantAdministrationOperatorContextSchema,
  provisionTenantCommandSchema,
  provisionTenantResultSchema,
  type AdoptOrganizationCommand,
  type AdoptOrganizationResult,
  type AdoptTenantCommand,
  type AdoptTenantResult,
  type ConfiguredTenantAdministrationOperatorContext,
  type ProvisionTenantCommand,
  type ProvisionTenantResult,
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

const one = <Row extends DatabaseRow>(rows: readonly Row[]): Row | undefined =>
  rows.length === 1 ? rows[0] : undefined;

export const createConfiguredTenantAdministrationService = (
  dependencies: ConfiguredTenantAdministrationDependencies = {},
) => {
  const operator = configuredContext(dependencies.environment ?? process.env);
  const run = dependencies.runtimeTransaction ?? withRuntimeTransaction;

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
  });
};

const defaultService = createConfiguredTenantAdministrationService();
export const provisionTenant = defaultService.provisionTenant;
export const adoptTenant = defaultService.adoptTenant;
export const adoptOrganization = defaultService.adoptOrganization;
