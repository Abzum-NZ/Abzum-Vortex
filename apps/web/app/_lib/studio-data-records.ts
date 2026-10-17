import "server-only";

import {
  BuilderAuthorityError,
  collectRecordLinks,
  createBuilderAuthority,
  protectedQueryCommandSchema,
  recordLinkPlainText,
  requireBuilderAuthority,
  type ProjectedRecordLinks,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  builderKeySchema,
  describeFailure,
  isRecord,
  namespacedKeySchema,
  organizationIdSchema,
  sameId,
  type IdentitySession,
  type JsonValue,
} from "@vortex/platform/schema";
import { z } from "zod";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { studioDraftTargetFacts } from "./studio-application-draft";
import { loadInstalledContext, requestDependencies } from "./application-page/load";
import { createPlacementReadServices } from "./application-page/placement-services";
import { loadOrganizationLauncher } from "./organization-context";
import { getQueryContinuationKey } from "./query-continuation-key";
import type { ModuleRelease } from "./application-page/types";

const requestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    moduleKey: namespacedKeySchema,
    recordKey: builderKeySchema,
    /** A query of the record type's module; absent to read the record type through its first plain query. */
    queryKey: builderKeySchema.optional(),
    pageSize: z.number().int().min(1).max(200),
    continuationToken: z.string().min(1).max(65_536).optional(),
    pageDirection: z.enum(["forward", "backward"]).optional(),
  })
  .strict();

/** One column of the results grid: a field the query returns, by its label. */
export type StudioDataColumn = Readonly<{ key: string; label: string }>;

export type StudioDataRecordsResult =
  | Readonly<{
      kind: "available";
      /** The query the records were read through, by its label. */
      queryLabel: string;
      columns: readonly StudioDataColumn[];
      /** The column holding each record's title, when the query returns it: a record picker shows it. */
      titleColumn?: string;
      rows: readonly Readonly<{ id: string; cells: Readonly<Record<string, string>> }>[];
      next?: string;
      previous?: string;
    }>
  /** The running application does not have this module, record type or query yet: preview or publish first. */
  | Readonly<{ kind: "not_installed" }>
  /** The record type is installed, but has no query without inputs to read its records through. */
  | Readonly<{ kind: "no_query" }>
  /** The query refused this read, for example because it needs inputs or the builder may not read it. */
  | Readonly<{ kind: "query_refused"; reason: string }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type ModuleRecordType = ModuleRelease["content"]["recordTypes"][number];
type ModuleField = ModuleRecordType["fields"][number];
type ModuleQuery = ModuleRelease["content"]["queries"][number];

const sentence = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return words.length === 0 ? key : words[0]!.toUpperCase() + words.slice(1);
};

/** The query a record type is read through when none is chosen: its first plain query (no inputs, no groups). */
const plainQueryOf = (module: ModuleRelease, record: ModuleRecordType): ModuleQuery | undefined =>
  module.content.queries.find(
    (query) =>
      query.recordType.state === "resolved" &&
      sameId(String(query.recordType.recordTypeId), String(record.recordTypeId)) &&
      query.inputs.length === 0 &&
      query.groupByFieldIds.length === 0,
  );

const moneyText = (value: Record<string, JsonValue>): string | undefined =>
  (typeof value.amount === "string" || typeof value.amount === "number") &&
  typeof value.currency === "string"
    ? `${value.currency} ${value.amount}`
    : undefined;

/** The plain text one stored value shows in the grid; never an identity. */
const cellText = (
  field: ModuleField,
  value: JsonValue | undefined,
  links: ProjectedRecordLinks | undefined,
): string => {
  if (value === undefined || value === null) return "";
  if (field.type === "choice" || field.type === "several_choices") {
    const options = field.settings.options;
    const labelOf = (item: JsonValue) =>
      options.find((option) => option.value === item)?.label ?? String(item);
    return Array.isArray(value) ? value.map(labelOf).join(", ") : labelOf(value);
  }
  if (field.type === "link" || field.type === "link_to_one_of_several")
    return (Array.isArray(value) ? value : [value])
      .map((item) => recordLinkPlainText(item, links) ?? "Linked record")
      .join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (isRecord(value))
    return (
      moneyText(value as Record<string, JsonValue>) ??
      (typeof value.text === "string" ? value.text : "Set")
    );
  return "";
};

/**
 * Reads, with the builder's own access, one page of the records of a record type, or of one query,
 * in the running application. It reads through the running application's own query service against
 * the installed release, so the builder sees exactly the records and fields they may read there.
 * A module, record type or query that is only in the draft has no records to read yet.
 */
export const readStudioDataRecords = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioDataRecordsResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const parsed = requestSchema.safeParse(candidate);
  if (!organization.success || !parsed.success) return { kind: "refused" };
  const request = parsed.data;
  try {
    const allowed = await humanOrganizationRequests().run(
      session,
      { organizationId: organization.data },
      async (transaction, scope) => {
        const authority = createBuilderAuthority({
          transaction,
          scope,
          targetFacts: studioDraftTargetFacts,
          permissions: platformPermissionSource,
        });
        try {
          await requireBuilderAuthority(authority, {
            kind: "draft_change",
            rootId: request.rootId,
          });
        } catch (error) {
          if (error instanceof BuilderAuthorityError) return false;
          throw error;
        }
        return true;
      },
    );
    if (allowed.kind !== "available")
      return allowed.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    if (!allowed.value) return { kind: "refused" };

    const dependencies = requestDependencies();
    const selection = { organizationId: organization.data, applicationRootId: request.rootId };
    const installed = await loadInstalledContext(session, dependencies, selection);
    if (installed.kind !== "available") return { kind: "not_installed" };
    const context = installed.value;
    const module = context.releaseSet.modules.find(
      (candidateModule) => candidateModule.definitionKey === request.moduleKey,
    );
    const record = module?.content.recordTypes.find(
      (candidateRecord) => candidateRecord.key === request.recordKey,
    );
    if (module === undefined || record === undefined) return { kind: "not_installed" };
    const query =
      request.queryKey === undefined
        ? plainQueryOf(module, record)
        : module.content.queries.find((candidateQuery) => candidateQuery.key === request.queryKey);
    if (query === undefined)
      return request.queryKey === undefined ? { kind: "no_query" } : { kind: "not_installed" };
    const queryRecord =
      query.recordType.state === "resolved"
        ? context.releaseSet.modules
            .flatMap((candidateModule) => candidateModule.content.recordTypes)
            .find((candidateRecord) =>
              sameId(
                String(candidateRecord.recordTypeId),
                String((query.recordType as { recordTypeId: string }).recordTypeId),
              ),
            )
        : undefined;
    if (queryRecord === undefined) return { kind: "not_installed" };

    const launcher = await loadOrganizationLauncher(session);
    const entry =
      launcher.kind === "available"
        ? launcher.entries.find((candidateEntry) =>
            sameId(candidateEntry.organizationId, organization.data),
          )
        : undefined;
    if (entry === undefined) return { kind: "refused" };
    const services = createPlacementReadServices({
      session,
      selection,
      dependencies,
      continuationKey: getQueryContinuationKey(),
      tenantShortName: entry.tenantShortName,
      organizationShortName: entry.organizationShortName,
    });
    const command = protectedQueryCommandSchema.safeParse({
      moduleRootId: module.rootId,
      queryId: query.queryId,
      inputValues: {},
      requestedFieldIds: query.selectedFieldIds,
      requestedSystemFieldKeys: [],
      sort: [],
      sortableFieldIds: [],
      filterableFieldIds: [],
      searchableFieldIds: [],
      pageSize: request.pageSize,
      ...(request.continuationToken === undefined
        ? {}
        : { continuationToken: request.continuationToken }),
      ...(request.pageDirection === undefined ? {} : { pageDirection: request.pageDirection }),
    });
    if (!command.success) return { kind: "query_refused", reason: "request_invalid" };
    const result = await services.queries.run(session, selection, command.data);
    if (result.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (result.kind !== "available") return { kind: "refused" };
    if (result.value.outcome !== "completed")
      return { kind: "query_refused", reason: result.value.reasonCode };
    const page = result.value;
    const fields = query.selectedFieldIds.flatMap((fieldId) =>
      queryRecord.fields.filter((field) => sameId(String(field.fieldId), String(fieldId))),
    );
    const links =
      collectRecordLinks(page.rows).length === 0
        ? undefined
        : await services.recordLinkResolver(context)(collectRecordLinks(page.rows));
    const valueOf = (
      values: Readonly<Record<string, JsonValue>>,
      field: ModuleField,
    ): JsonValue | undefined =>
      Object.entries(values).find(([fieldId]) => sameId(fieldId, String(field.fieldId)))?.[1];
    const title = fields.find((field) =>
      sameId(String(field.fieldId), String(queryRecord.titleFieldId)),
    );
    return {
      kind: "available",
      queryLabel: sentence(query.key),
      columns: fields.map((field) => ({ key: field.key, label: field.label })),
      ...(title === undefined ? {} : { titleColumn: title.key }),
      rows: page.rows.map((row) => ({
        id: String(row.recordId),
        cells: Object.fromEntries(
          fields.map((field) => [field.key, cellText(field, valueOf(row.values, field), links)]),
        ),
      })),
      ...(page.nextContinuationToken === undefined ? {} : { next: page.nextContinuationToken }),
      ...(page.previousContinuationToken === undefined
        ? {}
        : { previous: page.previousContinuationToken }),
    };
  } catch (error) {
    console.error(
      `[studio] data records unavailable: STUDIO_DATA_RECORDS_FAILED cause=${describeFailure(error)}`,
    );
    return { kind: "temporarily_unavailable" };
  }
};
