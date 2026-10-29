import "server-only";

import { z } from "zod";
import type { SelectedOrganizationScope } from "../access/identity-access";
import { jsonValueSchema } from "../catalogue/common";
import { fieldIdSchema, recordIdSchema, revisionSchema } from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import type { ApplicationSearch } from "../definition/application-contracts";
import type { ModuleField } from "../definition/module-contracts";
import { activeApplicationInstallationSchema } from "../files/storage";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { protectedQueryRowCapabilitiesSchema } from "../queries/protected-query-contracts";
import { searchConfiguredApplication, type ApplicationSearchResult } from "./application-search";

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
  recordTypeFields: readonly Readonly<{ recordTypeId: string; fields: readonly ModuleField[] }>[];
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
    allowedRecordTypeIds: ReadonlySet<string>;
    after?: Readonly<{ score: number; id: string }>;
  }>,
): Promise<ApplicationSearchResult> => {
  const { transaction, scope, configuration } = input;
  const applicationRootId = scope.applicationRootId;
  if (applicationRootId === undefined) throw new Error("SEARCH_SCOPE_UNAVAILABLE");
  return searchConfiguredApplication({
    scope,
    configuration,
    expression: input.expression,
    allowedRecordTypeIds: input.allowedRecordTypeIds,
    ...(input.after === undefined ? {} : { after: input.after }),
    fieldsByRecordType: new Map(
      input.modules.flatMap((module) =>
        module.recordTypeFields.map((record) => [record.recordTypeId.toLowerCase(), record.fields]),
      ),
    ),
    readPage: async (request) => {
      const entry = configuration.recordTypes.find(
        (item) =>
          item.recordType.state === "resolved" &&
          sameId(item.recordType.recordTypeId, request.recordTypeId),
      );
      if (entry?.recordType.state !== "resolved") throw new Error("SEARCH_RECORD_TYPE_MISSING");
      const moduleRootId = entry.recordType.moduleRootId;
      const module = input.modules.find((item) => sameId(item.rootId, moduleRootId));
      if (
        module === undefined ||
        !module.recordTypeIds.some((id) => sameId(id, request.recordTypeId))
      )
        throw new Error("SEARCH_MODULE_MISSING");
      const rows = await transaction.query<DatabaseRow>`
        with active_installation as materialized (
          select vortex_definition.read_current_active_installation() as value
        ), verified_installation as materialized (
          select value from active_installation
          where pg_catalog.lower(value ->> 'organizationId') = pg_catalog.lower(${scope.organizationId}::text)
            and pg_catalog.lower(value ->> 'applicationRootId') = pg_catalog.lower(${applicationRootId}::text)
            and (value ->> 'applicationReleaseRevision')::bigint = ${input.applicationReleaseRevision}::bigint
            and exists (select 1 from pg_catalog.jsonb_array_elements(value -> 'moduleBindings') binding(value)
              where pg_catalog.lower(binding.value ->> 'moduleRootId') = pg_catalog.lower(${module.rootId}::text)
                and (binding.value ->> 'moduleReleaseRevision')::bigint = ${module.releaseRevision}::bigint
                and binding.value ->> 'state' = 'active')
        )
        select active_installation.value as installation, verified_installation.value is not null as verified,
          page.record_id, page.score, page.record, page.capabilities
        from active_installation
        left join verified_installation on true
        left join lateral vortex_record.search_document_page(
          ${scope.organizationId}::uuid, ${applicationRootId}::uuid, ${request.recordTypeId}::uuid,
          ${JSON.stringify(request.fields)}::text::jsonb, ${request.titleFieldId}::uuid,
          ${JSON.stringify(request.terms)}::text::jsonb, ${JSON.stringify(request.filters)}::text::jsonb,
          ${request.after?.score ?? null}::integer, ${request.after?.id ?? null}::uuid, ${request.limit}::integer
        ) page on verified_installation.value is not null
      `;
      return rows.flatMap((row) => {
        const installation = activeApplicationInstallationSchema.parse(row.installation);
        if (
          row.verified !== true ||
          installation.applicationReleaseRevision !== input.applicationReleaseRevision ||
          !sameId(installation.organizationId, scope.organizationId) ||
          !sameId(installation.applicationRootId, applicationRootId)
        )
          throw new Error("SEARCH_INSTALLATION_MISMATCH");
        if (row.record_id === null) return [];
        const record = recordSchema.parse(row.record);
        protectedQueryRowCapabilitiesSchema.parse(row.capabilities);
        const recordId = recordIdSchema.parse(row.record_id);
        if (!sameId(record.recordId, recordId)) throw new Error("SEARCH_RECORD_ID_MISMATCH");
        return [{ recordId, rank: z.number().int().nonnegative().parse(row.score), record }];
      });
    },
  });
};
