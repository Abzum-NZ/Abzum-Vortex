import "server-only";

import {
  identitySessionSchema,
  organizationLauncherEntrySchema,
  organizationLauncherResolutionSchema,
  type IdentitySession,
  type OrganizationLauncherEntry,
  type OrganizationLauncherResolution,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

type LauncherRow = DatabaseRow & {
  organization_id: unknown;
  tenant_display_name: unknown;
  organization_display_name: unknown;
  account_display_name: unknown;
};

export type OrganizationLauncherServiceDependencies = Readonly<{
  runtimeTransaction?: RuntimeTransactionRunner;
}>;

const entry = (row: LauncherRow): OrganizationLauncherEntry =>
  organizationLauncherEntrySchema.parse({
    organizationId: row.organization_id,
    tenantDisplayName: row.tenant_display_name,
    organizationDisplayName: row.organization_display_name,
    ...(row.account_display_name === null || row.account_display_name === undefined
      ? {}
      : { accountDisplayName: row.account_display_name }),
  });

export const createOrganizationLauncherService = (
  dependencies: OrganizationLauncherServiceDependencies = {},
) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  return Object.freeze({
    async list(session: IdentitySession): Promise<OrganizationLauncherResolution> {
      const parsed = identitySessionSchema.safeParse(session);
      if (!parsed.success)
        return organizationLauncherResolutionSchema.parse({ kind: "invalid_session_state" });

      try {
        const entries = await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<LauncherRow>`
            select *
            from vortex_identity.list_organization_launcher(${parsed.data.identityId}::uuid)
          `;
          return rows.map(entry);
        });
        return organizationLauncherResolutionSchema.parse({ kind: "available", entries });
      } catch {
        return organizationLauncherResolutionSchema.parse({ kind: "temporarily_unavailable" });
      }
    },
  });
};

const defaultService = createOrganizationLauncherService();

export const listOrganizationLauncher = defaultService.list;
