import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  applicationRootIdSchema,
  databaseRevision,
  namespacedKeySchema,
  revisionSchema,
} from "../schema";

const rowSchema = z
  .object({
    root_id: z.string(),
    kind: z.literal("application"),
    definition_key: namespacedKeySchema,
    display_name: z.string().nullable(),
    draft_revision: revisionSchema.nullable(),
    current_release_revision: revisionSchema.nullable(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    edited_at: z.string().datetime({ offset: true }),
    edited_by: z.string().uuid(),
    application_origin_kind: z.enum(["ordinary", "platform_system_application"]),
  })
  .strict();

export type OrganizationBuilderRoot = Readonly<{
  rootId: string;
  key: string;
  name: string;
  draftRevision: number | null;
  currentReleaseRevision: number | null;
  isSystemApplication: boolean;
  description: string | null;
  icon: string | null;
  editedAt: string;
  editedBy: string;
}>;

/** Reads one bounded organization listing through the protected Definition API. */
export const listOrganizationBuilderRoots = async (
  transaction: RequestDatabaseTransaction,
  afterKey: string | null,
): Promise<Readonly<{ roots: readonly OrganizationBuilderRoot[]; nextCursor: string | null }>> => {
  const rows = await transaction.query<DatabaseRow>`
    select root_id, kind, definition_key, display_name, draft_revision,
      current_release_revision, application_origin_kind, description, icon, edited_at, edited_by
    from vortex_definition.list_organization_builder_roots(${afterKey}::text)
  `;
  if (rows.length > 41) throw new Error("STUDIO_ROOT_LIST_STORAGE_INVALID");
  const parsedRoots = rows.map((row) => {
    const parsed = rowSchema.parse({
      ...row,
      edited_at: row.edited_at instanceof Date ? row.edited_at.toISOString() : row.edited_at,
      draft_revision: row.draft_revision === null ? null : databaseRevision(row.draft_revision),
      current_release_revision:
        row.current_release_revision === null
          ? null
          : databaseRevision(row.current_release_revision),
    });
    const rootId = applicationRootIdSchema.parse(parsed.root_id);
    return {
      rootId,
      key: parsed.definition_key,
      name: parsed.display_name ?? parsed.definition_key,
      draftRevision: parsed.draft_revision,
      currentReleaseRevision: parsed.current_release_revision,
      description: parsed.description,
      icon: parsed.icon,
      editedAt: parsed.edited_at,
      editedBy: parsed.edited_by,
      isSystemApplication: parsed.application_origin_kind === "platform_system_application",
    };
  });
  const roots = parsedRoots.slice(0, 40);
  return { roots, nextCursor: rows.length > 40 ? roots.at(-1)!.key : null };
};
