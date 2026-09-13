import "server-only";

import { createHash } from "node:crypto";
import {
  changeTenantAdministratorCommandSchema,
  changeTenantAdministratorResultSchema,
  grantTenantAdministratorCommandSchema,
  grantTenantAdministratorResultSchema,
  identitySessionSchema,
  revokeTenantAdministratorCommandSchema,
  revokeTenantAdministratorResultSchema,
  tenantAssignmentPageSchema,
  tenantAssignmentQuerySchema,
  tenantHierarchyEntrySchema,
  tenantHierarchyPageSchema,
  tenantHierarchyQuerySchema,
  tenantLauncherPageSchema,
  tenantLauncherQuerySchema,
  tenantOrganizationQuerySchema,
  type ChangeTenantAdministratorCommand,
  type ChangeTenantAdministratorResult,
  type GrantTenantAdministratorCommand,
  type GrantTenantAdministratorResult,
  type IdentitySession,
  type RevokeTenantAdministratorCommand,
  type RevokeTenantAdministratorResult,
  type TenantAssignmentQuery,
  type TenantAssignmentReadResult,
  type TenantHierarchyQuery,
  type TenantHierarchyResult,
  type TenantLauncherQuery,
  type TenantLauncherResult,
  type TenantOrganizationQuery,
  type TenantOrganizationResult,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

type Runner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;
export type TenantGovernanceServiceDependencies = Readonly<{ runtimeTransaction?: Runner }>;

type MutationRow = DatabaseRow & {
  outcome: unknown;
  operation: unknown;
  assignment_id: unknown;
  revision: unknown;
  correlation_id: unknown;
  accepted_at: unknown;
};
const timestamp = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
const revision = (value: unknown) =>
  typeof value === "bigint"
    ? Number(value)
    : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
const fingerprint = (command: object) =>
  `sha256:${createHash("sha256").update(JSON.stringify(command), "utf8").digest("hex")}`;
const databaseCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
const mutationCode = (error: unknown) => {
  switch (databaseCode(error)) {
    case "V3001":
      return "duplicate_conflict" as const;
    case "V3102":
      return "stale_revision" as const;
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
const readRefusal = (invalid: boolean) => ({
  outcome: "refused" as const,
  code: invalid ? ("invalid_request" as const) : ("unavailable" as const),
});

const hierarchyEntry = (row: DatabaseRow) =>
  tenantHierarchyEntrySchema.parse({
    organizationId: row.organization_id,
    ...(row.parent_organization_id == null
      ? {}
      : { parentOrganizationId: row.parent_organization_id }),
    shortName: row.short_name,
    displayName: row.display_name,
    state: row.state,
    revision: revision(row.revision),
  });
const assignmentEntry = (row: DatabaseRow) => ({
  assignmentId: row.assignment_id,
  identityId: row.identity_id,
  capabilities: row.capability_keys,
  startsAt: timestamp(row.starts_at),
  ...(row.expires_at == null ? {} : { expiresAt: timestamp(row.expires_at) }),
  revision: revision(row.revision),
  outcome: row.outcome,
});
const mutationResult = (row: MutationRow | undefined) =>
  row && {
    outcome: row.outcome,
    operation: row.operation,
    assignmentId: row.assignment_id,
    revision: revision(row.revision),
    correlationId: row.correlation_id,
    acceptedAt: timestamp(row.accepted_at),
  };

export const createTenantGovernanceService = (
  dependencies: TenantGovernanceServiceDependencies = {},
) => {
  const run = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const sessionIdentity = (session: IdentitySession) => identitySessionSchema.safeParse(session);
  return Object.freeze({
    async listTenants(
      session: IdentitySession,
      candidate: TenantLauncherQuery,
    ): Promise<TenantLauncherResult> {
      const verified = sessionIdentity(session);
      const query = tenantLauncherQuerySchema.safeParse(candidate);
      if (!verified.success || !query.success) return readRefusal(true);
      try {
        const page = await run(async (tx) => {
          const rows =
            await tx.query`select * from vortex_identity.list_tenant_launcher(${verified.data.identityId}::uuid, ${query.data.limit + 1}::integer, ${query.data.after ?? null}::uuid)`;
          const visible = rows
            .slice(0, query.data.limit)
            .map((row) => ({ tenantId: row.tenant_id, displayName: row.display_name }));
          return tenantLauncherPageSchema.parse({
            entries: visible,
            ...(rows.length > query.data.limit ? { next: visible.at(-1)?.tenantId } : {}),
          });
        });
        return { outcome: "available", page };
      } catch {
        return readRefusal(false);
      }
    },
    async listHierarchy(
      session: IdentitySession,
      candidate: TenantHierarchyQuery,
    ): Promise<TenantHierarchyResult> {
      const verified = sessionIdentity(session);
      const query = tenantHierarchyQuerySchema.safeParse(candidate);
      if (!verified.success || !query.success) return readRefusal(true);
      try {
        const page = await run(async (tx) => {
          const rows =
            await tx.query`select * from vortex_identity.list_tenant_hierarchy(${verified.data.identityId}::uuid, ${query.data.tenantId}::uuid, ${query.data.page.limit + 1}::integer, ${query.data.page.after ?? null}::uuid)`;
          const entries = rows.slice(0, query.data.page.limit).map(hierarchyEntry);
          return tenantHierarchyPageSchema.parse({
            entries,
            ...(rows.length > query.data.page.limit
              ? { next: entries.at(-1)?.organizationId }
              : {}),
          });
        });
        return { outcome: "available", page };
      } catch {
        return readRefusal(false);
      }
    },
    async readOrganization(
      session: IdentitySession,
      candidate: TenantOrganizationQuery,
    ): Promise<TenantOrganizationResult> {
      const verified = sessionIdentity(session);
      const query = tenantOrganizationQuerySchema.safeParse(candidate);
      if (!verified.success || !query.success) return readRefusal(true);
      try {
        const rows = await run(
          (tx) =>
            tx.query`select * from vortex_identity.read_tenant_organization(${verified.data.identityId}::uuid, ${query.data.tenantId}::uuid, ${query.data.organizationId}::uuid)`,
        );
        if (rows.length !== 1) return readRefusal(false);
        return { outcome: "available", organization: hierarchyEntry(rows[0]!) };
      } catch {
        return readRefusal(false);
      }
    },
    async listAssignments(
      session: IdentitySession,
      candidate: TenantAssignmentQuery,
    ): Promise<TenantAssignmentReadResult> {
      const verified = sessionIdentity(session);
      const query = tenantAssignmentQuerySchema.safeParse(candidate);
      if (!verified.success || !query.success) return readRefusal(true);
      try {
        const page = await run(async (tx) => {
          const rows =
            await tx.query`select * from vortex_identity.list_tenant_administrator_assignments(${verified.data.identityId}::uuid, ${query.data.tenantId}::uuid, ${query.data.page.limit + 1}::integer, ${query.data.page.after ?? null}::uuid)`;
          const entries = rows.slice(0, query.data.page.limit).map(assignmentEntry);
          return tenantAssignmentPageSchema.parse({
            entries,
            ...(rows.length > query.data.page.limit ? { next: entries.at(-1)?.assignmentId } : {}),
          });
        });
        return { outcome: "available", page };
      } catch {
        return readRefusal(false);
      }
    },
    async grant(
      session: IdentitySession,
      candidate: GrantTenantAdministratorCommand,
    ): Promise<GrantTenantAdministratorResult> {
      const verified = sessionIdentity(session);
      const command = grantTenantAdministratorCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "grant_tenant_administrator",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const rows = await run(
          (tx) =>
            tx.query<MutationRow>`select * from vortex_identity.grant_tenant_administrator(${verified.data.identityId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.tenantId}::uuid, ${value.identityId}::uuid, ${JSON.stringify(value.capabilities)}::jsonb, ${value.startsAt}::timestamptz, ${value.expiresAt ?? null}::timestamptz)`,
        );
        return grantTenantAdministratorResultSchema.parse(
          mutationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "grant_tenant_administrator",
          code: mutationCode(error),
        };
      }
    },
    async change(
      session: IdentitySession,
      candidate: ChangeTenantAdministratorCommand,
    ): Promise<ChangeTenantAdministratorResult> {
      const verified = sessionIdentity(session);
      const command = changeTenantAdministratorCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "change_tenant_administrator",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const rows = await run(
          (tx) =>
            tx.query<MutationRow>`select * from vortex_identity.change_tenant_administrator(${verified.data.identityId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.tenantId}::uuid, ${value.assignmentId}::uuid, ${value.expectedRevision}::bigint, ${JSON.stringify(value.capabilities)}::jsonb, ${value.startsAt}::timestamptz, ${value.expiresAt ?? null}::timestamptz)`,
        );
        return changeTenantAdministratorResultSchema.parse(
          mutationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "change_tenant_administrator",
          code: mutationCode(error),
        };
      }
    },
    async revoke(
      session: IdentitySession,
      candidate: RevokeTenantAdministratorCommand,
    ): Promise<RevokeTenantAdministratorResult> {
      const verified = sessionIdentity(session);
      const command = revokeTenantAdministratorCommandSchema.safeParse(candidate);
      if (!verified.success || !command.success)
        return {
          outcome: "refused",
          operation: "revoke_tenant_administrator",
          code: "invalid_command",
        };
      try {
        const value = command.data;
        const rows = await run(
          (tx) =>
            tx.query<MutationRow>`select * from vortex_identity.revoke_tenant_administrator(${verified.data.identityId}::uuid, ${value.duplicateKey}::uuid, ${fingerprint(value)}::text, ${value.tenantId}::uuid, ${value.assignmentId}::uuid, ${value.expectedRevision}::bigint)`,
        );
        return revokeTenantAdministratorResultSchema.parse(
          mutationResult(rows.length === 1 ? rows[0] : undefined),
        );
      } catch (error) {
        return {
          outcome: "refused",
          operation: "revoke_tenant_administrator",
          code: mutationCode(error),
        };
      }
    },
  });
};

const defaultService = createTenantGovernanceService();
export const listTenantLauncher = defaultService.listTenants;
export const listTenantHierarchy = defaultService.listHierarchy;
export const readTenantOrganization = defaultService.readOrganization;
export const listTenantAdministratorAssignments = defaultService.listAssignments;
export const grantTenantAdministrator = defaultService.grant;
export const changeTenantAdministrator = defaultService.change;
export const revokeTenantAdministrator = defaultService.revoke;
