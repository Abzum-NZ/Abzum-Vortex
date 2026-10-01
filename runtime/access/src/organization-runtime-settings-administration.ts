import "server-only";

import {
  unavailableError,
  databaseRevision,
  applicationRootIdSchema,
  organizationRuntimeSettingsSchema,
  type ApplicationRootId,
  type OrganizationRuntimeSettings,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

type ReadRow = DatabaseRow & {
  organization_id: unknown;
  language: unknown;
  time_zone: unknown;
  currency: unknown;
  date_format: unknown;
  number_format: unknown;
  revision: unknown;
};
type DefaultApplicationRow = DatabaseRow & { default_application_root_id: unknown };

const unavailableCode = "ORGANIZATION_RUNTIME_SETTINGS_UNAVAILABLE";

/** Reads only the organisation already established by the request context. */
export const readCurrentOrganizationRuntimeSettingsAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<OrganizationRuntimeSettings | undefined> => {
  const rows = await transaction.query<ReadRow>`
    select * from vortex_access.read_current_organization_runtime_settings_for_application()
  `;

  if (rows.length > 1) throw unavailableError(unavailableCode, "42501");
  const row = rows[0];
  if (row === undefined) return undefined;
  const settings = organizationRuntimeSettingsSchema.safeParse({
    organizationId: row.organization_id,
    language: row.language,
    timeZone: row.time_zone,
    currency: row.currency,
    dateFormat: row.date_format,
    numberFormat: row.number_format,
    revision: databaseRevision(row.revision),
  });
  if (!settings.success) throw unavailableError(unavailableCode, "42501");
  return settings.data;
};

/** The request context fixes the organisation; the application still needs its own Access check. */
export const readCurrentOrganizationDefaultApplicationAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<ApplicationRootId | null> => {
  const rows = await transaction.query<DefaultApplicationRow>`
    select vortex_access.read_current_organization_default_application_for_application()
      as default_application_root_id
  `;
  if (rows.length !== 1 || rows[0] === undefined) throw unavailableError(unavailableCode, "42501");
  const value = rows[0].default_application_root_id;
  if (value === null) return null;
  const parsed = applicationRootIdSchema.safeParse(value);
  if (!parsed.success) throw unavailableError(unavailableCode, "42501");
  return parsed.data;
};
