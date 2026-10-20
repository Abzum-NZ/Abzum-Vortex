import "server-only";

import {
  readQueryBindings,
  readRecordsTableContract,
  sameId,
  type BlockPropertyValueContract,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../../schema";
import { recordLinkLabelKey, type RecordLinkReference } from "../../definition/app-index";
import type { InstalledRuntimeContext } from "../../definition/installed-runtime-context";
import { protectedQueryCommandSchema } from "../../queries/index";
import {
  collectRecordLinks,
  projectRecordDetailData,
  type ProjectedCellValue,
  type RecordLinkResolver,
} from "../component-data-projection";
import type { PageSubjectReadResult } from "../page-subject-read";
import {
  findModuleQuery,
  moduleFieldDisplay,
  placementSettingsOf,
  type PlacementReadEntry,
} from "../placement-read/shared";
import { resolveQueryBindings, type QueryBindingContext } from "../query-binding-resolver";
import type { RecordsTableQueryRunner } from "../records-table-query";
import { logRecordsTableRequestRefusal, recordsTableRequestRefusal } from "./index";

/** One related record of an expanded row: its own record page, when the viewer may open it. */
export type RowDetailRow = Readonly<{
  recordId: string;
  href?: string;
  fields: readonly Readonly<{ key: string; label: string; value: ProjectedCellValue }>[];
}>;

/**
 * One page of an expanded row's related records. A refusal and an error carry nothing, so the
 * panel cannot show records the read did not authorise; the cause stays in the server log.
 */
export type RowDetailResult =
  | Readonly<{
      status: "ready";
      columns: readonly Readonly<{ key: string; label: string }>[];
      rows: readonly RowDetailRow[];
      nextContinuationToken?: string;
    }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "error" }>;

/** One expanded row's read: the installed placement, the row the browser named and the services. */
export type RowDetailRequest = Readonly<{
  context: InstalledRuntimeContext;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  /** The Records table placement of the viewer's current page projection. */
  placement: PlacementReadEntry;
  /** The only part of the row the browser supplies; everything else is read again here. */
  parentRecordId: string;
  continuationToken?: string;
  /** The page's binding context; This row is added here from the row read under the viewer. */
  bindings: QueryBindingContext;
  queries: RecordsTableQueryRunner;
  readRecord: (recordTypeId: string, recordId: string) => Promise<PageSubjectReadResult>;
  resolveRecordLinks: RecordLinkResolver;
}>;

const refused = Object.freeze({ status: "refused" as const });
const failed = Object.freeze({ status: "error" as const });

/** A temporary failure: the panel offers to try again, and the cause stays in the server log. */
const fail = (cause: string): RowDetailResult => {
  console.error(`[records-table] row detail unavailable where=row_detail cause=${cause}`);
  return failed;
};

const refuse = (reason: string): RowDetailResult => {
  logRecordsTableRequestRefusal(recordsTableRequestRefusal("row_detail", reason), "row_detail");
  return refused;
};

/**
 * Reads one page of an expanded row's related records. The row is read again under the viewer's
 * current access, so a row the viewer cannot read is refused; the related records query runs
 * through the protected Query engine with its inputs from the one binding resolver, where This row
 * is that row, and returns only the chosen columns under the viewer's field policy. The link that
 * makes the records related must still lead from the query's record type to the table's, as
 * publication checked. Link titles, the related records' own page addresses among them, are read
 * in one batch for the page.
 */
export const readRecordsTableRowDetail = async (
  request: RowDetailRequest,
): Promise<RowDetailResult> => {
  const { context, placement } = request;
  const contract = readRecordsTableContract(placementSettingsOf(placement));
  const feature = contract?.features.masterDetail;
  if (feature === undefined || !feature.enabled) return refuse("feature_off");
  const { relationship, childQuery, childColumns, childPageSize } = feature;
  if (
    relationship === undefined ||
    childQuery === undefined ||
    childColumns.length === 0 ||
    childPageSize === undefined
  )
    return refuse("feature_incomplete");
  const master =
    typeof placement.vortex.queryId === "string"
      ? findModuleQuery(context, placement.vortex.queryId)
      : undefined;
  const child = findModuleQuery(context, childQuery);
  const masterType = master?.query.recordType;
  const childType = child?.query.recordType;
  if (child === undefined || masterType?.state !== "resolved" || childType?.state !== "resolved")
    return refuse("query_not_installed");
  const masterTypeId = String(masterType.recordTypeId);
  const childTypeId = String(childType.recordTypeId);
  const linked = context.releaseSet.modules.some((module) =>
    module.content.recordTypes.some((recordType) =>
      recordType.relationships.some(
        (candidate) =>
          sameId(String(candidate.relationshipId), relationship) &&
          sameId(String(candidate.fromRecordTypeId), childTypeId) &&
          [
            ...(candidate.toRecordType === undefined ? [] : [candidate.toRecordType]),
            ...(candidate.toRecordTypes ?? []),
          ].some(
            (target) =>
              target.state === "resolved" && sameId(String(target.recordTypeId), masterTypeId),
          ),
      ),
    ),
  );
  if (!linked) return refuse("relationship_not_installed");

  const row = await request.readRecord(masterTypeId, request.parentRecordId);
  if (row.kind === "temporarily_unavailable") return fail("row_read_unavailable");
  if (row.kind !== "read") return refuse("row_unreadable");

  // The related records query binds its inputs in the feature's own settings group.
  const groupOf = (value: BlockPropertyValueContract | undefined) =>
    value?.kind === "group" ? value.properties : undefined;
  const bindings = readQueryBindings(
    groupOf(groupOf(placementSettingsOf(placement)["features"])?.["master_detail"]) ?? {},
  );
  if (bindings.kind === "malformed") return refuse("bindings_malformed");
  const resolution = await resolveQueryBindings(
    bindings.bindings,
    child.query.inputs,
    {
      ...request.bindings,
      row: {
        kind: "read",
        recordTypeId: masterTypeId,
        recordId: String(row.row.recordId),
        values: row.row.values,
      },
    },
    {},
    (cause) =>
      console.error(`[records-table] row detail input withheld where=row_detail cause=${cause}`),
  );
  // A required input with no value (the row's linking field is empty) has no related records.
  if (resolution.kind === "awaiting") return { status: "empty" };
  if (resolution.kind === "refused")
    return refuse(`binding ${resolution.part} ${resolution.reason}`);

  const fieldIds = [...new Set(childColumns.map((field) => field.toLowerCase()))];
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: child.module.rootId,
    queryId: child.query.queryId,
    inputValues: resolution.inputValues,
    requestedFieldIds: fieldIds,
    requestedSystemFieldKeys: [],
    sort: [],
    sortableFieldIds: [],
    filterableFieldIds: [],
    searchableFieldIds: [],
    pageSize: childPageSize,
    ...(request.continuationToken === undefined
      ? {}
      : { pageDirection: "forward", continuationToken: request.continuationToken }),
  });
  if (!command.success) return refuse("query_command_invalid");
  const result = await request.queries.run(request.session, request.selection, command.data);
  if (result.kind === "temporarily_unavailable") return fail("query_unavailable");
  if (result.kind !== "available") return refuse("query_refused");
  if (result.value.outcome === "refused")
    return refuse(`query_refused code=${result.value.reasonCode}`);
  const rows = result.value.rows;
  if (rows.length === 0 && request.continuationToken === undefined) return { status: "empty" };

  // One batched read of every link title the page shows, the related records' own among them.
  const own: RecordLinkReference[] = rows.map((related) => ({
    recordTypeId: childTypeId,
    recordId: String(related.recordId),
  }));
  const links = [...collectRecordLinks(rows), ...own];
  const recordLinks = await request.resolveRecordLinks(links);
  const display = moduleFieldDisplay(child.module);
  // Each related record is projected by the one record projection, as a record detail of the
  // chosen columns, so its values show exactly as every other block shows them.
  const settings: Readonly<Record<string, BlockPropertyValueContract>> = {
    detail_fields: {
      kind: "list",
      items: command.data.requestedFieldIds.map((fieldId) => ({
        kind: "group",
        properties: {
          field: { kind: "field_reference", fieldId },
          format: { kind: "choice", value: "automatic" },
        },
      })),
    },
    heading_source: { kind: "choice", value: "title" },
  };
  const projected: RowDetailRow[] = [];
  for (const related of rows) {
    const detail = projectRecordDetailData(
      {
        settings,
        ...display,
        ...(recordLinks === undefined ? {} : { recordLinks }),
      },
      [related],
    );
    if (detail === undefined || detail.status !== "ready") return fail("projection_failed");
    const link = recordLinks?.get(
      recordLinkLabelKey({ recordTypeId: childTypeId, recordId: String(related.recordId) }),
    );
    projected.push({
      recordId: String(related.recordId),
      ...(link?.kind === "record_link" && link.href !== undefined ? { href: link.href } : {}),
      fields: detail.values.fields,
    });
  }
  const columns = fieldIds.map((fieldId) => ({
    key: fieldId,
    label: display.fieldLabels[fieldId] ?? fieldId,
  }));
  const next = result.value.nextContinuationToken;
  return {
    status: "ready",
    columns,
    rows: projected,
    ...(next === undefined ? {} : { nextContinuationToken: next }),
  };
};
