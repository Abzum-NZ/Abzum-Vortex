import "server-only";

import {
  authoredGridLayout,
  sameId,
  type IdentitySession,
  type JsonValue,
  type RecordsRangeSummaryField,
  type RecordsRangeSummaryRequest,
  type RecordsRangeSummaryResult,
  type RecordsRangeSummaryTotal,
  type RecordsTableFilterValue,
  type RecordsTableSortKey,
} from "../../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../../access/index";
import { createProtectedQueryService, type QueryContinuationKey } from "../../queries/index";
import type {
  AggregateDescriptor,
  AggregateResult,
  ArrangementField,
} from "../../queries/arrangement-contracts";
import { aggregateSupportsFieldType, computeAggregates } from "../../queries/exact-aggregation";
import {
  fieldChoiceLabelsOf,
  fieldDateTypesOf,
  fieldFilterTargetsOf,
  fieldLabelsOf,
  fieldLinkTypesOf,
} from "../placement-read/shared";
import { buildRecordsTableQueryCommand } from "../records-table-query";
import { openRecordsSelection } from "../records-selection-seal";
import { formatDecimal, formatMoney } from "../value-format";
import { loadRecordsTablePlacement, type RecordsTableCommandAddress } from "./placement";
import {
  logRecordsTableRequestRefusal,
  recordsTableRequestRefusal,
  type RecordsTableRequestRefusal,
} from "./index";

/**
 * The totals of a selected range of one Records table page, for the spreadsheet status bar. It
 * re-reads the installed placement, the viewer's feature projection inputs and the sealed read the
 * rows came from, then reads the shown page ONCE under the person's current access (the page
 * position comes from the address, the identities are kept only if every one of them is on that
 * page) and totals the readable selected columns with the one exact aggregation code. A field the
 * person cannot read on every record is reported as withheld, never totalled. Nothing here reads
 * a record per identity, another page, or a value the browser sent.
 */
export type RecordsRangeSummaryDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ continuationKey: QueryContinuationKey }>;

type Money = Readonly<{ amount: string; currency: string }>;

const valueText = (type: ArrangementField["type"], value: unknown): string => {
  if (type === "money") return formatMoney(value as Money);
  if (type === "whole_number" || type === "decimal_number")
    return formatDecimal(value as number | string);
  return String(value);
};

/** One total as the status bar shows it, formatted here so the browser does no arithmetic. */
const totalOf = (
  type: ArrangementField["type"],
  operation: AggregateDescriptor["operation"],
  result: AggregateResult | undefined,
): RecordsRangeSummaryTotal => {
  if (result === undefined) return { kind: "none" };
  if (result.outcome === "refused") return { kind: "mixed_currency" };
  if (result.value === null || (operation !== "count" && result.valueCount === 0))
    return { kind: "none" };
  return {
    kind: "value",
    text:
      operation === "count" ? formatDecimal(result.value as number) : valueText(type, result.value),
  };
};

const refusedBy = (refusal: RecordsTableRequestRefusal): RecordsRangeSummaryResult => {
  logRecordsTableRequestRefusal(refusal, "range-summary");
  return { kind: "refused" };
};

export const createRecordsRangeSummaryService = (dependencies: RecordsRangeSummaryDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const queries = createProtectedQueryService(dependencies);

  return Object.freeze({
    async summarise(
      session: IdentitySession,
      address: RecordsTableCommandAddress,
      request: RecordsRangeSummaryRequest,
    ): Promise<RecordsRangeSummaryResult> {
      const refuse = (reason: string): RecordsRangeSummaryResult =>
        refusedBy(recordsTableRequestRefusal("range_summary", reason));
      const placement = await loadRecordsTablePlacement(
        requests,
        session,
        address,
        request.placementId,
      );
      if ("refused" in placement) return refuse(placement.refused);
      const spreadsheet = placement.contract.features.spreadsheet;
      // The per-viewer feature projection is decided again on every request: a table whose
      // spreadsheet status bar is off answers nothing.
      if (
        !spreadsheet.enabled ||
        spreadsheet.rangeSelect !== true ||
        spreadsheet.statusBarFields.length === 0 ||
        spreadsheet.statusBarOperations.length === 0
      )
        return refuse("status_bar_off");
      const offered = spreadsheet.statusBarFields.map((field) => field.toLowerCase());
      const requested = [...new Set(request.fieldIds.map((field) => field.toLowerCase()))];
      if (requested.length !== request.fieldIds.length) return refuse("field_repeated");
      if (requested.some((field) => !offered.includes(field))) return refuse("field_not_offered");
      const declared = new Set(
        placement.contract.columns.map((column) => column.field.toLowerCase()),
      );
      if (requested.some((field) => !declared.has(field))) return refuse("field_not_a_column");
      const recordIds = [
        ...new Set(request.recordIds.map((recordId) => String(recordId).toLowerCase())),
      ];
      if (recordIds.length !== request.recordIds.length) return refuse("record_repeated");

      const descriptor = openRecordsSelection(request.token, dependencies.continuationKey, {
        session,
        selection: address.selection,
        installationRevision: placement.installed.applicationReleaseRevision,
        placementId: request.placementId,
      });
      if (descriptor === undefined) return refuse("descriptor_unreadable");
      if (
        !sameId(descriptor.moduleRootId, String(placement.module.rootId)) ||
        !sameId(descriptor.queryId, String(placement.query.queryId))
      )
        return refuse("descriptor_other_query");

      const authored = authoredGridLayout(placement.contract);
      if (authored === undefined) return refuse("layout_unavailable");
      // Only the requested columns are read; every other value stays unread.
      const layout = {
        ...authored,
        columns: authored.columns.map((column) => ({
          ...column,
          visible: requested.includes(column.fieldId.toLowerCase()),
        })),
      };
      const built = buildRecordsTableQueryCommand({
        moduleRootId: placement.module.rootId,
        queryId: placement.query.queryId,
        settings: placement.settings,
        inputValues: descriptor.inputValues as Readonly<Record<string, JsonValue>>,
        state: {
          sort: descriptor.sort as unknown as readonly RecordsTableSortKey[],
          filters: descriptor.filters as unknown as readonly RecordsTableFilterValue[],
          search: descriptor.search,
          page:
            request.page === undefined
              ? undefined
              : {
                  page: 2,
                  pageDirection: request.page.pageDirection,
                  ...(request.page.continuationToken === undefined
                    ? {}
                    : { continuationToken: request.page.continuationToken }),
                },
        },
        layout: {
          storage: "preview",
          queryId: String(placement.query.queryId).toLowerCase(),
          revision: null,
          layout,
          authored: layout,
          reset: false,
        },
        filterTargets: fieldFilterTargetsOf(placement.module),
        ...(descriptor.timeZone === undefined ? {} : { timeZone: descriptor.timeZone }),
        fieldLabels: fieldLabelsOf(placement.module),
        fieldChoiceLabels: fieldChoiceLabelsOf(placement.module),
        fieldDateTypes: fieldDateTypesOf(placement.module),
        fieldLinkTypes: fieldLinkTypesOf(placement.module),
      });
      if (built.kind === "refused") return refuse(`command_${built.part}_${built.reason}`);

      // The one protected read of the shown page, under the person's current access.
      const read = await queries.run(session, address.selection, built.command);
      if (read.kind === "temporarily_unavailable") return { kind: "unavailable" };
      if (read.kind !== "available") return refuse(`read_${read.kind}`);
      if (read.value.outcome !== "completed")
        return refuse(`read_refused_${read.value.reasonCode}`);
      const onPage = new Map(
        read.value.rows.map((row) => [String(row.recordId).toLowerCase(), row]),
      );
      const rows = recordIds.flatMap((recordId) => {
        const row = onPage.get(recordId);
        return row === undefined ? [] : [row];
      });
      // An identity that is not on the shown page (another page, removed, or no longer readable)
      // refuses the whole request; a total over a different set than the one selected is wrong.
      if (rows.length !== recordIds.length) return refuse("records_not_on_page");

      const readable = new Set(
        read.value.fieldBounds.readableFieldIds.map((id) => String(id).toLowerCase()),
      );
      const fieldTypes = new Map<string, ArrangementField["type"]>();
      for (const recordType of placement.module.content.recordTypes)
        for (const field of recordType.fields)
          fieldTypes.set(
            String(field.fieldId).toLowerCase(),
            field.type as ArrangementField["type"],
          );
      const fields: RecordsRangeSummaryField[] = [];
      for (const fieldId of requested) {
        if (!readable.has(fieldId)) {
          fields.push({ state: "withheld", fieldId });
          continue;
        }
        const type = fieldTypes.get(fieldId);
        if (type === undefined) return refuse("field_type_unknown");
        const operations = spreadsheet.statusBarOperations.filter((operation) =>
          aggregateSupportsFieldType(operation, type),
        );
        const results = computeAggregates(
          rows,
          operations.map((operation) => ({
            operation,
            alias: operation,
            fieldId: fieldId as AggregateDescriptor["fieldId"],
          })),
          fieldTypes,
        );
        fields.push({
          state: "totals",
          fieldId,
          totals: operations.map((operation) => ({
            operation,
            total: totalOf(type, operation, results[operation]),
          })),
        });
      }
      return { kind: "summarised", fields };
    },
  });
};
