import "server-only";

import { z } from "zod";
import {
  activeApplicationInstallationEvidenceSchema,
  fieldIdSchema,
  jsonValueSchema,
  revisionSchema,
  sameId,
  selectedOrganizationScopeSchema,
  viewerSafeRecordLinkIdentitySchema,
  viewerSafeRecordLinkTitleSchema,
  type SelectedOrganizationScope,
  type ViewerSafeRecordLinkIdentity,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { protectedQueryRowCapabilitiesSchema } from "./protected-query-contracts";

const unavailable = { outcome: "unavailable" } as const;

const viewerSafeRecordLinkReadCommandSchema = z
  .object({
    identity: viewerSafeRecordLinkIdentitySchema,
    /** The exact Application revision already checked by App's installed-context loader. */
    applicationReleaseRevision: revisionSchema,
    /** Read only the title field selected from the exact installed Module release. */
    titleFieldId: fieldIdSchema,
  })
  .strict();

const readableRecordSchema = z
  .object({
    outcome: z.literal("allowed"),
    recordId: z.string().uuid(),
    concurrencyNumber: revisionSchema,
    values: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();

type RecordLinkReadRow = DatabaseRow & {
  readonly active_installation: unknown;
  readonly result: unknown;
  readonly capabilities: unknown;
};

export const viewerSafeRecordLinkTitleReadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("read"), title: viewerSafeRecordLinkTitleSchema }).strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type ViewerSafeRecordLinkTitleReadResult = z.infer<
  typeof viewerSafeRecordLinkTitleReadResultSchema
>;

const currentInstallationMatches = (
  candidate: unknown,
  scope: SelectedOrganizationScope,
  identity: ViewerSafeRecordLinkIdentity,
  applicationReleaseRevision: number,
): boolean => {
  const installation = activeApplicationInstallationEvidenceSchema.safeParse(candidate);
  return (
    installation.success &&
    sameId(scope.organizationId, identity.organizationId) &&
    scope.applicationRootId !== undefined &&
    sameId(scope.applicationRootId, identity.applicationRootId) &&
    sameId(installation.data.organizationId, identity.organizationId) &&
    sameId(installation.data.applicationRootId, identity.applicationRootId) &&
    installation.data.applicationReleaseRevision === applicationReleaseRevision &&
    installation.data.moduleBindings.some(
      (binding) =>
        sameId(binding.moduleRootId, identity.moduleRootId) &&
        binding.moduleReleaseRevision === identity.moduleReleaseRevision,
    )
  );
};

/**
 * Reads only the configured title through the existing protected Record projection. App supplies
 * the exact installed-context selection in the same Access-resolved request transaction; the
 * tuple is checked against that transaction's live installation and never acts as authority.
 */
const read = async (
  transaction: RequestDatabaseTransaction,
  scopeCandidate: unknown,
  commandCandidate: unknown,
): Promise<ViewerSafeRecordLinkTitleReadResult> => {
  const scope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
  const command = viewerSafeRecordLinkReadCommandSchema.safeParse(commandCandidate);
  if (!scope.success || !command.success) return unavailable;
  if (
    scope.data.applicationRootId === undefined ||
    !sameId(scope.data.organizationId, command.data.identity.organizationId) ||
    !sameId(scope.data.applicationRootId, command.data.identity.applicationRootId)
  )
    return unavailable;

  try {
    // The installation predicate and both protected reads share one statement snapshot. The
    // Record functions make the current row and field decision; they expose no direct table data.
    const rows = await transaction.query<RecordLinkReadRow>`
      with active_installation as materialized (
        select vortex_module.read_current_active_installation() as value
      ), verified_installation as materialized (
        select value
        from active_installation
        where pg_catalog.lower(value ->> 'organizationId') =
            pg_catalog.lower(${command.data.identity.organizationId}::text)
          and pg_catalog.lower(value ->> 'applicationRootId') =
            pg_catalog.lower(${command.data.identity.applicationRootId}::text)
          and (value ->> 'applicationReleaseRevision')::bigint =
            ${command.data.applicationReleaseRevision}::bigint
          and exists (
            select 1
            from pg_catalog.jsonb_array_elements(value -> 'moduleBindings') as binding(value)
            where pg_catalog.lower(binding.value ->> 'moduleRootId') =
                pg_catalog.lower(${command.data.identity.moduleRootId}::text)
              and (binding.value ->> 'moduleReleaseRevision')::bigint =
                ${command.data.identity.moduleReleaseRevision}::bigint
              and binding.value ->> 'state' = 'active'
          )
      )
      select
        active_installation.value as active_installation,
        coalesce(
          (
            select vortex_record.read_record(
              ${command.data.identity.recordTypeId}::uuid,
              ${command.data.identity.recordId}::uuid
            )
            from verified_installation
          ),
          pg_catalog.jsonb_build_object('outcome', 'refused')
        ) as result,
        (
          select vortex_record.read_record_capabilities(
            ${command.data.identity.recordTypeId}::uuid,
            ${command.data.identity.recordId}::uuid
          )
          from verified_installation
        ) as capabilities
      from active_installation
    `;
    if (rows.length !== 1 || rows[0] === undefined) return unavailable;

    const row = rows[0];
    if (
      !currentInstallationMatches(
        row.active_installation,
        scope.data,
        command.data.identity,
        command.data.applicationReleaseRevision,
      )
    )
      return unavailable;

    const record = readableRecordSchema.safeParse(row.result);
    const capabilities = protectedQueryRowCapabilitiesSchema.safeParse(row.capabilities);
    if (
      !record.success ||
      !capabilities.success ||
      !sameId(record.data.recordId, command.data.identity.recordId)
    )
      return unavailable;

    const titleEntries = Object.entries(record.data.values).filter(([fieldId]) =>
      sameId(fieldId, command.data.titleFieldId),
    );
    if (titleEntries.length !== 1) return unavailable;
    const title = viewerSafeRecordLinkTitleSchema.safeParse(titleEntries[0]?.[1]);
    return title.success ? { outcome: "read", title: title.data } : unavailable;
  } catch {
    return unavailable;
  }
};

/** One uncached protected Query reader for the current target record and its configured title. */
export const createViewerSafeRecordLinkReadService = () => Object.freeze({ read });

export type ViewerSafeRecordLinkReadService = ReturnType<
  typeof createViewerSafeRecordLinkReadService
>;
