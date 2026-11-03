import "server-only";

import { z } from "zod";
import { revisionSchema } from "../catalogue/identifiers";
import { databaseRevision, unavailableError } from "../catalogue/runtime-primitives";
import {
  organizationThemeSelectionSchema,
  type OrganizationThemeSelection,
} from "../theme/organization-theme-selection";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";

const unavailableCode = "ORGANIZATION_THEME_UNAVAILABLE";

/** The organisation theme as stored: the selection delta and the revision a change must name. */
export type OrganizationThemeRead = Readonly<{
  /** The dimensions the organisation changed from the platform default. */
  selection: OrganizationThemeSelection;
  /** 0 when the organisation has stored no theme yet. */
  revision: number;
}>;

type ThemeRow = DatabaseRow & { selection: unknown; revision: unknown };

/** Reads only the organisation already established by the request context; every member may read it. */
export const readCurrentOrganizationThemeAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<OrganizationThemeRead> => {
  const rows = await transaction.query<ThemeRow>`
    select selection, revision from vortex_access.read_current_organization_theme_for_application()
  `;
  if (rows.length > 1) throw unavailableError(unavailableCode, "42501");
  const row = rows[0];
  if (row === undefined) return { selection: {}, revision: 0 };
  const selection = organizationThemeSelectionSchema.safeParse(row.selection);
  const revision = revisionSchema.safeParse(databaseRevision(row.revision));
  if (!selection.success || !revision.success) throw unavailableError(unavailableCode, "42501");
  return { selection: selection.data, revision: revision.data };
};

const changeResultSchema = z
  .object({ outcome: z.enum(["saved", "conflict"]), revision: z.number().int().min(0) })
  .strict();

/**
 * Replaces the organisation theme at the expected revision. The database refuses a caller without
 * the organisation settings manage permission; a stale revision comes back as a conflict that
 * carries the stored revision.
 */
export const changeCurrentOrganizationThemeAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
  expectedRevision: number,
  selection: OrganizationThemeSelection,
): Promise<z.infer<typeof changeResultSchema>> => {
  const checked = organizationThemeSelectionSchema.parse(selection);
  const rows = await transaction.query<DatabaseRow & { result: unknown }>`
    select vortex_access.change_current_organization_theme(
      ${expectedRevision}::bigint,
      ${JSON.stringify(checked)}::text::jsonb
    ) as result
  `;
  const parsed = changeResultSchema.safeParse(rows[0]?.result);
  if (rows.length !== 1 || !parsed.success) throw unavailableError(unavailableCode);
  return parsed.data;
};

/** Whether the request's person may change the organisation theme; the change checks it again. */
export const readOrganizationThemeChangePermittedAfterAuthorization = async (
  transaction: RequestDatabaseTransaction,
): Promise<boolean> => {
  const rows = await transaction.query<DatabaseRow & { permitted: unknown }>`
    select vortex_access.organization_theme_change_is_permitted() as permitted
  `;
  const permitted = rows[0]?.permitted;
  if (rows.length !== 1 || typeof permitted !== "boolean") throw unavailableError(unavailableCode);
  return permitted;
};
