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

const viewerSafeRecordLinkReadFieldsCommandSchema = z
  .object({
    identity: viewerSafeRecordLinkIdentitySchema,
    /** The exact Application revision already checked by App's installed-context loader. */
    applicationReleaseRevision: revisionSchema,
    /** Field IDs declared by the trusted caller for the exact installed Module release. */
    fieldIds: z
      .array(fieldIdSchema)
      .min(1)
      .max(20)
      .superRefine((fieldIds, context) => {
        const seen = new Set<string>();
        for (const [index, fieldId] of fieldIds.entries()) {
          const normalizedFieldId = fieldId.toLowerCase();
          if (seen.has(normalizedFieldId))
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Each requested field ID must be unique",
            });
          seen.add(normalizedFieldId);
        }
      }),
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

const viewerSafeRecordLinkFieldValuesSchema = z.record(fieldIdSchema, jsonValueSchema).superRefine(
  (values, context) => {
    const fieldIds = Object.keys(values);
    if (fieldIds.length < 1 || fieldIds.length > 20)
      context.addIssue({
        code: "custom",
        message: "A selected-record read returns between 1 and 20 fields",
      });
    const normalizedFieldIds = fieldIds.map((fieldId) => fieldId.toLowerCase());
    if (new Set(normalizedFieldIds).size !== normalizedFieldIds.length)
      context.addIssue({
        code: "custom",
        message: "A selected-record read returns each field ID once",
      });
  },
);

export const viewerSafeRecordLinkTitleReadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("read"), title: viewerSafeRecordLinkTitleSchema }).strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type ViewerSafeRecordLinkTitleReadResult = z.infer<
  typeof viewerSafeRecordLinkTitleReadResultSchema
>;

export const viewerSafeRecordLinkFieldsReadResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("read"),
      values: viewerSafeRecordLinkFieldValuesSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export type ViewerSafeRecordLinkFieldsReadResult = z.infer<
  typeof viewerSafeRecordLinkFieldsReadResultSchema
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

/** Run both protected Record reads behind the same exact current-installation gate. */
const readProtectedRecord = (
  transaction: RequestDatabaseTransaction,
  identity: ViewerSafeRecordLinkIdentity,
  applicationReleaseRevision: number,
) => transaction.query<RecordLinkReadRow>`
  with active_installation as materialized (
    select vortex_module.read_current_active_installation() as value
  ), verified_installation as materialized (
    select value
    from active_installation
    where pg_catalog.lower(value ->> 'organizationId') =
        pg_catalog.lower(${identity.organizationId}::text)
      and pg_catalog.lower(value ->> 'applicationRootId') =
        pg_catalog.lower(${identity.applicationRootId}::text)
      and (value ->> 'applicationReleaseRevision')::bigint =
        ${applicationReleaseRevision}::bigint
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(value -> 'moduleBindings') as binding(value)
        where pg_catalog.lower(binding.value ->> 'moduleRootId') =
            pg_catalog.lower(${identity.moduleRootId}::text)
          and (binding.value ->> 'moduleReleaseRevision')::bigint =
            ${identity.moduleReleaseRevision}::bigint
          and binding.value ->> 'state' = 'active'
      )
  )
  select
    active_installation.value as active_installation,
    coalesce(
      (
        select vortex_record.read_record(
          ${identity.recordTypeId}::uuid,
          ${identity.recordId}::uuid
        )
        from verified_installation
      ),
      pg_catalog.jsonb_build_object('outcome', 'refused')
    ) as result,
    (
      select vortex_record.read_record_capabilities(
        ${identity.recordTypeId}::uuid,
        ${identity.recordId}::uuid
      )
      from verified_installation
    ) as capabilities
  from active_installation
`;

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
    // The installation predicate gates both protected reads in one statement. The Record
    // functions make the current row and field decision; they expose no direct table data.
    const rows = await readProtectedRecord(
      transaction,
      command.data.identity,
      command.data.applicationReleaseRevision,
    );
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

/**
 * Reads only the requested values from the current protected Record projection. The trusted
 * caller supplies IDs from the exact installed Module release; Query still validates the list,
 * installation identity and current Record authority before returning any values. The caller
 * must resolve the target and fields from the installed release; these inputs select a read but
 * never grant authority.
 */
const readFields = async (
  transaction: RequestDatabaseTransaction,
  scopeCandidate: unknown,
  commandCandidate: unknown,
): Promise<ViewerSafeRecordLinkFieldsReadResult> => {
  const scope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
  const command = viewerSafeRecordLinkReadFieldsCommandSchema.safeParse(commandCandidate);
  if (!scope.success || !command.success) return unavailable;
  if (
    scope.data.applicationRootId === undefined ||
    !sameId(scope.data.organizationId, command.data.identity.organizationId) ||
    !sameId(scope.data.applicationRootId, command.data.identity.applicationRootId)
  )
    return unavailable;

  try {
    const rows = await readProtectedRecord(
      transaction,
      command.data.identity,
      command.data.applicationReleaseRevision,
    );
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

    const values: Record<string, z.infer<typeof jsonValueSchema>> = {};
    for (const fieldId of command.data.fieldIds) {
      const matchingEntries = Object.entries(record.data.values).filter(([candidateFieldId]) =>
        sameId(candidateFieldId, fieldId),
      );
      if (matchingEntries.length !== 1) return unavailable;
      const matchingEntry = matchingEntries[0];
      if (matchingEntry === undefined) return unavailable;
      values[fieldId] = matchingEntry[1];
    }

    return viewerSafeRecordLinkFieldsReadResultSchema.parse({ outcome: "read", values });
  } catch {
    return unavailable;
  }
};

/** One uncached protected Query reader for a target record's title or selected fields. */
export const createViewerSafeRecordLinkReadService = () => Object.freeze({ read, readFields });

export type ViewerSafeRecordLinkReadService = ReturnType<
  typeof createViewerSafeRecordLinkReadService
>;
