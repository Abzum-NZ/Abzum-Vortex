import "server-only";

import {
  collectRecordLinks,
  collectRecordLinkValues,
  protectedQueryCommandSchema,
  protectedQuerySummaryCommandSchema,
  recordLinkPlainText,
  type ProjectedRecordLinks,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  builderKeySchema,
  describeFailure,
  isRecord,
  namespacedKeySchema,
  organizationIdSchema,
  revisionSchema,
  sameId,
  type IdentitySession,
  type JsonValue,
} from "@vortex/platform/schema";
import { z } from "zod";
import { openStudioPreviewRead } from "./studio-preview-read";
import type { ModuleRelease } from "./application-page/types";

const requestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    /** The saved draft revision whose preview the records are read from. */
    draftRevision: revisionSchema,
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

/** One total of a summary, as a person reads it. */
export type StudioDataTotal = Readonly<{ alias: string; label: string; value: string }>;

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
      /** Read from the preview while it still runs an older revision's data shape: read again shortly. */
      behind: boolean;
    }>
  /** A query that groups records or adds totals: its groups, each with its count and totals, and its overall totals. */
  | Readonly<{
      kind: "summary";
      queryLabel: string;
      /** The fields the records are grouped by, by label; empty when the query only adds totals. */
      groupColumns: readonly StudioDataColumn[];
      /** One page of the groups, in the summary's own group order. */
      groups: readonly Readonly<{
        key: string;
        values: readonly string[];
        count: number;
        totals: readonly StudioDataTotal[];
      }>[];
      /** How many groups the summary has in all, over every page. */
      groupCount: number;
      /** The groups after and before this page, by keyset: the key of the group the page ends or starts at. */
      next?: string;
      previous?: string;
      totalRowCount: number;
      totals: readonly StudioDataTotal[];
      behind: boolean;
    }>
  /** The saved draft revision does not have this module, record type or query: save first. */
  | Readonly<{ kind: "not_saved" }>
  /** The preview is still moving to the saved revision that has this: read again shortly. */
  | Readonly<{ kind: "following" }>
  /** The saved draft changed since the revision the request names: read again for the current one. */
  | Readonly<{ kind: "conflict" }>
  /** The record type has no query without inputs to read its records through. */
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

/** The query a record type is read through when none is chosen: its first plain query (no inputs, groups or totals). */
const plainQueryOf = (module: ModuleRelease, record: ModuleRecordType): ModuleQuery | undefined =>
  module.content.queries.find(
    (query) =>
      query.recordType.state === "resolved" &&
      sameId(String(query.recordType.recordTypeId), String(record.recordTypeId)) &&
      query.inputs.length === 0 &&
      query.groupByFieldIds.length === 0 &&
      query.aggregates.length === 0,
  );

const totalLabels = {
  count: "Number of records",
  sum: "Sum",
  average: "Average",
  minimum: "Lowest",
  maximum: "Highest",
} as const;

/** A total's value as plain text: a number, an amount of money, a date. */
const totalText = (result: Readonly<{ outcome: string; value?: JsonValue }>): string => {
  if (result.outcome !== "completed") return "Not one currency";
  const value = result.value;
  if (value === null || value === undefined) return "None";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  return isRecord(value) ? (moneyText(value as Record<string, JsonValue>) ?? "Set") : "Set";
};

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
 * Reads one page of the records of a record type, or of one query, through the builder's own
 * preview installation of exactly the saved draft revision. It reads through the running
 * application's own query service against the preview, so a record type or query that is only in
 * the saved draft has its records too, and the builder sees exactly the records and fields their
 * preview access lets them read. A page is at most 200 records, read with keyset paging.
 */
export const readStudioDataRecords = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
  signal?: AbortSignal,
): Promise<StudioDataRecordsResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const parsed = requestSchema.safeParse(candidate);
  if (!organization.success || !parsed.success) return { kind: "refused" };
  const request = parsed.data;
  try {
    // The builder's draft authority is checked where the saved draft and their preview are read.
    const preview = await openStudioPreviewRead(
      session,
      organization.data,
      request.rootId,
      request.draftRevision,
      signal,
    );
    if (preview.kind !== "available") return preview;

    const { context, selection, services, behind } = preview;
    // What the preview does not have yet, while it still moves to this revision, follows shortly.
    const missing = behind ? ({ kind: "following" } as const) : ({ kind: "not_saved" } as const);
    const module = context.releaseSet.modules.find(
      (candidateModule) => candidateModule.definitionKey === request.moduleKey,
    );
    const record = module?.content.recordTypes.find(
      (candidateRecord) => candidateRecord.key === request.recordKey,
    );
    if (module === undefined || record === undefined) return missing;
    const query =
      request.queryKey === undefined
        ? plainQueryOf(module, record)
        : module.content.queries.find((candidateQuery) => candidateQuery.key === request.queryKey);
    if (query === undefined)
      return request.queryKey === undefined && !behind ? { kind: "no_query" } : missing;
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
    if (queryRecord === undefined) return missing;

    const summary = query.groupByFieldIds.length > 0 || query.aggregates.length > 0;
    const label = query.label ?? sentence(query.key);
    if (summary) {
      const summaryCommand = protectedQuerySummaryCommandSchema.safeParse({
        moduleRootId: module.rootId,
        queryId: query.queryId,
        inputValues: {},
      });
      if (!summaryCommand.success) return { kind: "query_refused", reason: "request_invalid" };
      const read = await services.queries.summarise(session, selection, summaryCommand.data);
      if (read.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
      if (read.kind !== "available") return { kind: "refused" };
      if (read.value.outcome !== "completed")
        return { kind: "query_refused", reason: read.value.reasonCode };
      const completed = read.value;
      const fieldOf = (fieldId: string) =>
        queryRecord.fields.find((field) => sameId(String(field.fieldId), fieldId));
      const groupFields = query.groupByFieldIds.flatMap((fieldId) => {
        const field = fieldOf(String(fieldId));
        return field === undefined ? [] : [field];
      });
      // Groups are paged by keyset like records: a page continues after (or before) the group whose
      // key the token names. A token that names no group of this summary is refused, never guessed.
      let start = 0;
      let end = Math.min(completed.groups.length, request.pageSize);
      if (request.continuationToken !== undefined) {
        const at = completed.groups.findIndex(
          (group) => `g:${group.groupKey}` === request.continuationToken,
        );
        if (at < 0) return { kind: "query_refused", reason: "continuation_invalid" };
        if (request.pageDirection === "backward") {
          end = at;
          start = Math.max(0, at - request.pageSize);
        } else {
          start = at + 1;
          end = Math.min(completed.groups.length, start + request.pageSize);
        }
      }
      const shown = completed.groups.slice(start, end);
      const groupLinks = collectRecordLinkValues(
        shown.flatMap((group) => Object.values<JsonValue>(group.groupValues)),
      );
      const links =
        groupLinks.length === 0
          ? undefined
          : await services.recordLinkResolver(context)(groupLinks);
      const totalsOf = (
        aggregates: Readonly<Record<string, Readonly<{ outcome: string; value?: JsonValue }>>>,
      ): StudioDataTotal[] =>
        query.aggregates.map((aggregate) => {
          const field =
            aggregate.fieldId === undefined ? undefined : fieldOf(String(aggregate.fieldId));
          const result = aggregates[aggregate.alias];
          return {
            alias: aggregate.alias,
            label:
              field === undefined
                ? totalLabels[aggregate.operation]
                : `${totalLabels[aggregate.operation]} of ${field.label}`,
            value: result === undefined ? "None" : totalText(result),
          };
        });
      return {
        kind: "summary",
        behind,
        queryLabel: label,
        totalRowCount: completed.totalRowCount,
        totals: totalsOf(completed.aggregates),
        groupColumns: groupFields.map((field) => ({ key: field.key, label: field.label })),
        groupCount: completed.groups.length,
        ...(end < completed.groups.length && shown.length > 0
          ? { next: `g:${shown.at(-1)!.groupKey}` }
          : {}),
        ...(start > 0 && shown.length > 0 ? { previous: `g:${shown[0]!.groupKey}` } : {}),
        groups: shown.map((group) => ({
          key: group.groupKey,
          count: group.rowCount,
          totals: totalsOf(group.aggregates),
          values: groupFields.map(
            (field) =>
              cellText(
                field,
                Object.entries(group.groupValues).find(([fieldId]) =>
                  sameId(fieldId, String(field.fieldId)),
                )?.[1],
                links,
              ) || "None",
          ),
        })),
      };
    }
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
      behind,
      queryLabel: label,
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
    signal?.throwIfAborted();
    console.error(
      `[studio] data records unavailable: STUDIO_DATA_RECORDS_FAILED cause=${describeFailure(error)}`,
    );
    return { kind: "temporarily_unavailable" };
  }
};
