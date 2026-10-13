import "server-only";

import { z } from "zod";
import {
  activeApplicationInstallationEvidenceSchema,
  fieldIdSchema,
  jsonValueSchema,
  recordIdSchema,
  revisionSchema,
  sameId,
  type ApplicationSearch,
  type SelectedOrganizationScope,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import { protectedQueryRowCapabilitiesSchema } from "../queries/index";
import {
  searchConfiguredApplication,
  type ApplicationSearchRecord,
  type ApplicationSearchResult,
} from "./application-search";
import { searchDocumentSchemaVersion, type SearchDocument } from "./document-store";
import { literalSearchRequiredTokens } from "./literal-search";

const candidateBatchSize = 1_000;
const firstRecordId = "00000000-0000-0000-0000-000000000000";
const documentRowSchema = z.object({
  record_id: recordIdSchema,
  source_record_version: z.coerce.number().pipe(revisionSchema),
  document_schema_version: z.literal(searchDocumentSchemaVersion),
  entries: z.array(
    z
      .object({
        fieldId: fieldIdSchema,
        priority: z.enum(["first", "normal", "last"]),
        weight: z.number(),
        text: z.string(),
      })
      .strict(),
  ),
  content_fingerprint: z.string(),
});
const recordSchema = z
  .object({
    outcome: z.literal("allowed"),
    recordId: recordIdSchema,
    concurrencyNumber: revisionSchema,
    values: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();

export type InstalledSearchModule = Readonly<{
  rootId: string;
  releaseRevision: number;
  recordTypeIds: readonly string[];
}>;

/** Search one installed application inside the caller's validated human transaction. */
export const searchInstalledApplication = async (
  input: Readonly<{
    transaction: RequestDatabaseTransaction;
    scope: SelectedOrganizationScope;
    configuration: ApplicationSearch;
    expression: string;
    applicationReleaseRevision: number;
    modules: readonly InstalledSearchModule[];
  }>,
): Promise<ApplicationSearchResult> => {
  const { transaction, scope, configuration, expression } = input;
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) throw new Error("SEARCH_SCOPE_UNAVAILABLE");
  const requiredTokens = literalSearchRequiredTokens(expression);
  if (requiredTokens === undefined) return { kind: "refused" };

  // Keyset pages cannot reveal how many hidden records the index contains. Exact
  // current Record reads decide which matches may leave the server.
  const candidateBatches = async function* (
    recordTypeId: string,
  ): AsyncGenerator<readonly SearchDocument[]> {
    let after = firstRecordId;
    for (;;) {
      const rows = await transaction.query<DatabaseRow>`
        select record_id, source_record_version, document_schema_version, entries, content_fingerprint
        from vortex_record.read_search_document_page(
          ${scope.organizationId}::uuid, ${applicationRootId}::uuid,
          ${recordTypeId}::uuid, ${after}::uuid,
          ${JSON.stringify(requiredTokens)}::text::jsonb, ${candidateBatchSize}::integer
        )
      `;
      if (rows.length === 0) return;
      const documents = rows.map((row): SearchDocument => {
        const parsed = documentRowSchema.parse({
          ...row,
          document_schema_version: Number(row.document_schema_version),
        });
        return {
          kind: "document",
          schemaVersion: searchDocumentSchemaVersion,
          organisationId: scope.organizationId,
          applicationRootId,
          recordTypeId,
          recordId: parsed.record_id,
          sourceRecordVersion: parsed.source_record_version,
          entries: parsed.entries,
          contentFingerprint: parsed.content_fingerprint,
        };
      });
      yield documents;
      after = documents[documents.length - 1]!.recordId;
    }
  };

  return await searchConfiguredApplication({
    scope,
    configuration,
    expression,
    candidateBatches,
    readCurrentRecords: async (request): Promise<ReadonlyMap<string, ApplicationSearchRecord>> => {
      const current = new Map<string, ApplicationSearchRecord>();
      const entry = configuration.recordTypes.find(
        (candidate) =>
          candidate.recordType.state === "resolved" &&
          sameId(candidate.recordType.recordTypeId, request.recordTypeId),
      );
      const recordType = entry?.recordType;
      if (
        entry === undefined ||
        recordType?.state !== "resolved" ||
        !sameId(request.organizationId, scope.organizationId) ||
        !sameId(request.applicationRootId, applicationRootId)
      )
        return current;
      const module = input.modules.find((candidate) =>
        sameId(candidate.rootId, recordType.moduleRootId),
      );
      if (
        module === undefined ||
        !module.recordTypeIds.some((id) => sameId(id, request.recordTypeId))
      )
        return current;

      // The pinned installation gates all current reads in one statement.
      const rows = await transaction.query<DatabaseRow>`
        with active_installation as materialized (
          select vortex_definition.read_current_active_installation() as value
        ), verified_installation as materialized (
          select value from active_installation
          where pg_catalog.lower(value ->> 'organizationId') = pg_catalog.lower(${scope.organizationId}::text)
            and pg_catalog.lower(value ->> 'applicationRootId') = pg_catalog.lower(${applicationRootId}::text)
            and (value ->> 'applicationReleaseRevision')::bigint = ${input.applicationReleaseRevision}::bigint
            and exists (select 1 from pg_catalog.jsonb_array_elements(value -> 'moduleBindings') as binding(value)
              where pg_catalog.lower(binding.value ->> 'moduleRootId') = pg_catalog.lower(${module.rootId}::text)
                and (binding.value ->> 'moduleReleaseRevision')::bigint = ${module.releaseRevision}::bigint
                and binding.value ->> 'state' = 'active')
        )
        select active_installation.value as installation, requested.record_id,
          (select vortex_record.read_record(${request.recordTypeId}::uuid, requested.record_id::uuid) from verified_installation) as record,
          (select vortex_record.read_record_capabilities(${request.recordTypeId}::uuid, requested.record_id::uuid) from verified_installation) as capabilities
        from active_installation
        cross join pg_catalog.jsonb_array_elements_text(${JSON.stringify(request.recordIds)}::text::jsonb) as requested(record_id)
      `;
      const allowedFields = new Set(
        [
          ...entry.fields.map((field) => String(field.fieldId)),
          String(entry.titleFieldId),
          ...(entry.subtitleFieldId === undefined ? [] : [String(entry.subtitleFieldId)]),
        ].map((fieldId) => fieldId.toLowerCase()),
      );
      for (const row of rows) {
        const installation = activeApplicationInstallationEvidenceSchema.parse(row.installation);
        if (
          installation.applicationReleaseRevision !== input.applicationReleaseRevision ||
          !sameId(installation.organizationId, scope.organizationId) ||
          !sameId(installation.applicationRootId, applicationRootId)
        )
          throw new Error("SEARCH_INSTALLATION_MISMATCH");
        if (row.record === null || row.capabilities === null) continue;
        if (
          typeof row.record === "object" &&
          row.record !== null &&
          "outcome" in row.record &&
          row.record.outcome === "refused"
        )
          continue;
        const record = recordSchema.parse(row.record);
        protectedQueryRowCapabilitiesSchema.parse(row.capabilities);
        if (!sameId(record.recordId, String(row.record_id)))
          throw new Error("SEARCH_RECORD_ID_MISMATCH");
        current.set(String(row.record_id).toLowerCase(), {
          concurrencyNumber: record.concurrencyNumber,
          values: Object.fromEntries(
            Object.entries(record.values).filter(([fieldId]) =>
              allowedFields.has(fieldId.toLowerCase()),
            ),
          ),
        });
      }
      return current;
    },
  });
};
