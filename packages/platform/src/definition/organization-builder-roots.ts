import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  applicationRootIdSchema,
  databaseRevision,
  moduleRootIdSchema,
  namespacedKeySchema,
  revisionSchema,
} from "../schema";

const rowSchema = z
  .object({
    root_id: z.string(),
    kind: z.enum(["application", "module"]),
    definition_key: namespacedKeySchema,
    display_name: z.string().nullable(),
    draft_revision: revisionSchema,
    current_release_revision: revisionSchema.nullable(),
    application_origin_kind: z.enum(["ordinary", "platform_system_application"]).nullable(),
  })
  .strict();

export type OrganizationBuilderRoot = Readonly<{
  rootId: string;
  kind: "application" | "module";
  key: string;
  name: string;
  draftRevision: number;
  currentReleaseRevision: number | null;
  isSystemApplication: boolean;
}>;

/** Reads one bounded organization listing through the protected Definition API. */
export const listOrganizationBuilderRoots = async (
  transaction: RequestDatabaseTransaction,
): Promise<readonly OrganizationBuilderRoot[]> => {
  const rows = await transaction.query<DatabaseRow>`
    select root_id, kind, definition_key, display_name, draft_revision,
      current_release_revision, application_origin_kind
    from vortex_definition.list_organization_builder_roots()
  `;
  if (rows.length > 200) throw new Error("STUDIO_ROOT_LIST_STORAGE_INVALID");
  return rows.map((row) => {
    const parsed = rowSchema.parse({
      ...row,
      draft_revision: databaseRevision(row.draft_revision),
      current_release_revision:
        row.current_release_revision === null
          ? null
          : databaseRevision(row.current_release_revision),
    });
    const rootId =
      parsed.kind === "application"
        ? applicationRootIdSchema.parse(parsed.root_id)
        : moduleRootIdSchema.parse(parsed.root_id);
    if (
      (parsed.kind === "module" && parsed.application_origin_kind !== null) ||
      (parsed.kind === "application" && parsed.application_origin_kind === null)
    )
      throw new Error("STUDIO_ROOT_LIST_STORAGE_INVALID");
    return {
      rootId,
      kind: parsed.kind,
      key: parsed.definition_key,
      name: parsed.display_name ?? parsed.definition_key,
      draftRevision: parsed.draft_revision,
      currentReleaseRevision: parsed.current_release_revision,
      isSystemApplication: parsed.application_origin_kind === "platform_system_application",
    };
  });
};
