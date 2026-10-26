import "server-only";

import type { JsonValue } from "../../catalogue/common";
import { describeFailure, sameId } from "../../catalogue/runtime-primitives";
import type { RecordsTableContract } from "../../definition/application-composition/records-display";
import {
  recordsTableGroupingFieldTypes,
  type RecordsTableGroupingFieldType,
} from "../../definition/application-composition/records-table-features/grouping";
import { readRecordsTableQueryState, type RecordsTablePageRequest } from "../records-table-state";
import { resolveRecordsTableView } from "./records-table-view";
import { tableReadValuesSchema } from "../display-payload-table";
import type { RecordsTableGroupRead } from "../records-table-features/grouping";
import { decideRecordTypeExport } from "../records-table-features/record-type-access";
import {
  projectRowActionAvailability,
  rowActionInstallationOf,
} from "../records-table-features/row-actions";
import type { RecordsTableReadDecider, RecordsTableReadDecisions } from "../records-table-query";
import {
  conditionalFormattingRelativeDates,
  conditionalFormattingUsesRelativeDates,
  personalFormattingRules,
  recordsTableRowActionsProjection,
  type ConditionalFormattingContext,
} from "../records-table-features";
import {
  readyPlacementData,
  fieldChoiceLabelsOf,
  fieldDateTypesOf,
  fieldEditorsOf,
  fieldFilterTargetsOf,
  fieldLabelsOf,
  fieldLinkTypesOf,
  logPlacementFailure,
  placementSettingsOf,
  type PlacementModule,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { PlacementReadInput } from "./types";

/**
 * The organisation's time zone when a filterable field holds a date and time, read under the same
 * access version the page was projected with; undefined when no such field is filterable.
 */
export const filterTimeZone = async (
  read: PlacementReadInput,
  needed: boolean,
): Promise<string | "unavailable" | undefined> => {
  if (!needed) return undefined;
  try {
    const settings = await read.services.readCalendarSettings();
    return settings.kind !== "available" ||
      (read.accessVersion !== undefined && settings.value.accessVersion !== read.accessVersion) ||
      settings.value.settings === undefined
      ? "unavailable"
      : settings.value.settings.timeZone;
  } catch (error) {
    console.error(`[page] table time zone unavailable cause=${describeFailure(error)}`);
    return "unavailable";
  }
};

/**
 * A Records table placement: one page of its bound query for its resolved inputs, the viewer's
 * query state from the address and the person's stored layout. The layout decides which columns
 * the read requests, checked against the declared columns and their current field policy; a column
 * the person can read on no record is never listed.
 */
export const readRecordsTable = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  bound: Readonly<{ module: PlacementModule; query: PlacementQuery }>,
  contract: RecordsTableContract,
  inputValues: Readonly<Record<string, JsonValue>>,
): Promise<void> => {
  const { placementId } = placement;
  const { address, data, gridLayouts } = read;
  // The table's whole query state comes from the page address; a malformed part is refused rather
  // than read as another order or projection.
  const addressEntries = Object.entries(read.parameters).flatMap(
    ([name, value]): [string, string][] => {
      return (typeof value === "string" ? [value] : (value ?? [])).map((text) => [name, text]);
    },
  );
  // A table that reads a grouped query has no flat rows: it opens grouped by its authored field,
  // the address may not name flat, and publication refuses one that is not.
  const queryGrouped = bound.query.groupByFieldIds.length > 0 || bound.query.aggregates.length > 0;
  const authoredGrouping = contract.features.grouping;
  if (
    queryGrouped &&
    !(
      authoredGrouping.enabled &&
      authoredGrouping.field !== undefined &&
      authoredGrouping.opensGrouped === true
    )
  ) {
    logPlacementFailure(address, placementId, "table_grouping_required");
    data[placementId] = { status: "error" };
    return;
  }
  const addressed = readRecordsTableQueryState(
    placementId,
    addressEntries,
    authoredGrouping.enabled && authoredGrouping.opensGrouped === true
      ? authoredGrouping.field
      : undefined,
    queryGrouped,
  );
  if (addressed.kind === "malformed") {
    logPlacementFailure(address, placementId, "table_state_malformed", addressed.part);
    // The address itself cannot be read (it names no field the viewer may or may not see).
    data[placementId] = { status: "refused", reason: "table_address_invalid" };
    return;
  }
  const view = resolveRecordsTableView({
    contract,
    placementId,
    bound,
    pageDefinition: read.pageDefinition,
    gridLayouts,
    addressEntries,
    state: addressed.state,
  });
  if (view === undefined) {
    logPlacementFailure(address, placementId, "table_columns_withheld");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const { layout, readable, state: effectiveState } = view;
  const recordType = bound.query.recordType;
  const titleFieldId = bound.module.content.recordTypes.find(
    (candidate) =>
      recordType.state === "resolved" &&
      sameId(String(candidate.recordTypeId), String(recordType.recordTypeId)),
  )?.titleFieldId;
  if (titleFieldId === undefined) throw new Error("RECORDS_TABLE_TITLE_FIELD_MISSING");
  // A date-and-time filter takes whole days in the organisation's time zone, so the zone is read
  // only when the table offers a filter on such a field.
  const filterTargets = Object.fromEntries(
    Object.entries(fieldFilterTargetsOf(bound.module)).filter(
      ([fieldId]) => readable === undefined || readable.has(fieldId),
    ),
  );
  // A grouping by a date field buckets it in the same zone, read only while the address groups.
  const groupingFeature = contract.features.grouping;
  const groupingField =
    groupingFeature.enabled && groupingFeature.field !== undefined
      ? bound.module.content.recordTypes
          .flatMap((candidate) => candidate.fields)
          .find((field) => sameId(String(field.fieldId), groupingFeature.field!))
      : undefined;
  const groupingDates =
    addressed.state.group !== undefined &&
    (groupingField?.type === "date" || groupingField?.type === "date_time");
  const timeZone = await filterTimeZone(
    read,
    (contract.features.columnFilters.enabled &&
      contract.features.columnFilters.fields.some(
        (field) => filterTargets[field.toLowerCase()]?.type === "date_time",
      )) ||
      groupingDates,
  );
  if (timeZone === "unavailable") {
    logPlacementFailure(address, placementId, "table_time_zone_unavailable");
    data[placementId] = { status: "error" };
    return;
  }
  // Formatting rules are evaluated with the bound record type's declared fields and, when a rule
  // compares with a relative date, the dates counted in the organisation's time zone.
  let formatting: ConditionalFormattingContext | undefined;
  if (contract.features.conditionalFormatting.enabled) {
    const recordTypeId =
      recordType.state === "resolved" ? String(recordType.recordTypeId).toLowerCase() : undefined;
    const recordFields =
      bound.module.content.recordTypes.find(
        (candidate) => String(candidate.recordTypeId).toLowerCase() === recordTypeId,
      )?.fields ?? [];
    let relativeDates: ConditionalFormattingContext["relativeDates"];
    if (
      conditionalFormattingUsesRelativeDates(contract, personalFormattingRules(contract, layout))
    ) {
      const timeZone = await read.bindings.timeZone();
      if (timeZone === undefined)
        logPlacementFailure(address, placementId, "table_formatting_time_zone_unavailable");
      else relativeDates = conditionalFormattingRelativeDates(read.bindings.now, timeZone);
    }
    formatting = { recordFields, relativeDates };
  }
  // A tree table reads one level at a time: its roots, or the children of the record a level
  // read names, whose page position is the level's own token and never the address's.
  const treeFeature = contract.features.tree;
  if (
    treeFeature.enabled &&
    (treeFeature.parentField === undefined || treeFeature.childPageSize === undefined)
  ) {
    logPlacementFailure(address, placementId, "table_tree_invalid");
    data[placementId] = { status: "error" };
    return;
  }
  const level =
    read.treeLevel !== undefined && sameId(read.treeLevel.placementId, placementId)
      ? read.treeLevel
      : undefined;
  if (level !== undefined && !(treeFeature.enabled && treeFeature.parentField !== undefined)) {
    logPlacementFailure(address, placementId, "table_tree_off");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const tree =
    treeFeature.enabled &&
    treeFeature.parentField !== undefined &&
    treeFeature.childPageSize !== undefined
      ? {
          parentFieldId: treeFeature.parentField.toLowerCase(),
          parentRecordId: level?.parentRecordId ?? null,
          pageSize:
            level === undefined
              ? contract.pageSize
              : Math.min(treeFeature.childPageSize, level.pageSize ?? treeFeature.childPageSize),
        }
      : undefined;
  // A grouped table counts its groups and reads one open group's page. The grouping field is the
  // authored one: the address may only switch grouping on or off, never name another field. A
  // members-only read (an open group's own pages) counts no group and takes its page position
  // from the group read, never from the address.
  if (
    groupingFeature.enabled &&
    (groupingFeature.field === undefined ||
      groupingFeature.unassignedLabel === undefined ||
      groupingFeature.groupPageSize === undefined ||
      groupingFeature.opensGrouped === undefined ||
      groupingField === undefined ||
      !(recordsTableGroupingFieldTypes as readonly string[]).includes(groupingField.type) ||
      ((groupingField.type === "date" || groupingField.type === "date_time") &&
        groupingFeature.dateUnit === undefined))
  ) {
    logPlacementFailure(address, placementId, "table_grouping_invalid");
    data[placementId] = { status: "error" };
    return;
  }
  const groupMembers =
    read.groupMembers !== undefined && sameId(read.groupMembers.placementId, placementId)
      ? read.groupMembers
      : undefined;
  const addressedGroup = addressed.state.group;
  if (
    (addressedGroup !== undefined || groupMembers !== undefined) &&
    !(
      groupingFeature.enabled &&
      groupingFeature.field !== undefined &&
      addressedGroup !== undefined &&
      sameId(addressedGroup.fieldId, groupingFeature.field)
    )
  ) {
    logPlacementFailure(address, placementId, "table_grouping_refused");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const group: RecordsTableGroupRead | undefined =
    groupingFeature.enabled &&
    groupingFeature.field !== undefined &&
    groupingFeature.unassignedLabel !== undefined &&
    groupingFeature.groupPageSize !== undefined &&
    groupingField !== undefined &&
    addressedGroup !== undefined
      ? {
          fieldId: groupingFeature.field.toLowerCase(),
          fieldType: groupingField.type as RecordsTableGroupingFieldType,
          ...(groupingFeature.dateUnit === undefined ? {} : { dateUnit: groupingFeature.dateUnit }),
          ...(timeZone === undefined ? {} : { timeZone }),
          pageSize: groupingFeature.groupPageSize,
          after: addressedGroup.after,
          unassignedLabel: groupingFeature.unassignedLabel,
          expanded: groupMembers?.groupKey ?? addressedGroup.expanded,
          membersOnly: groupMembers !== undefined,
          required: queryGrouped,
        }
      : undefined;
  // Export is projected only for a viewer whose export permission reaches every record, and a row
  // action only where the viewer may run it on that row. Both are decided inside the table read's
  // own request, from the rows it returned; the export route decides export again on every
  // request.
  const wantsExport = contract.features.export.enabled && recordType.state === "resolved";
  const wantsRowActions =
    contract.features.rowActions.enabled && contract.rowBehaviours.rowActions.length > 0;
  if (wantsRowActions && recordType.state !== "resolved")
    throw new Error("ROW_ACTION_RECORD_TYPE_UNRESOLVED");
  const resolvedRecordTypeId =
    recordType.state === "resolved" ? String(recordType.recordTypeId) : undefined;
  // A draft preview offers no export.
  const previewing = read.selection.previewInstallationId !== undefined;
  const decide: RecordsTableReadDecider | undefined =
    !wantsExport && !wantsRowActions
      ? undefined
      : async (transaction, scope, issuedAt, rows) => {
          const decisions: {
            exportAllowed?: boolean;
            rowActions?: NonNullable<RecordsTableReadDecisions["rowActions"]>;
          } = {};
          if (wantsExport && resolvedRecordTypeId !== undefined)
            decisions.exportAllowed = previewing
              ? false
              : (
                  await decideRecordTypeExport(
                    transaction,
                    scope,
                    read.context,
                    resolvedRecordTypeId,
                  )
                ).kind === "permitted";
          const implied = wantsRowActions
            ? recordsTableRowActionsProjection(
                contract.features.rowActions,
                contract.rowBehaviours,
                rows,
              )
            : undefined;
          if (implied !== undefined && resolvedRecordTypeId !== undefined)
            decisions.rowActions = await projectRowActionAvailability(
              transaction,
              rowActionInstallationOf(read.context),
              placementId,
              resolvedRecordTypeId,
              implied,
              issuedAt,
            );
          return decisions;
        };
  const continuation = read.tableContinuation;
  const explicitRequest =
    continuation !== undefined && sameId(continuation.placementId, placementId)
      ? continuation.request
      : undefined;
  // An explicit page request wins; otherwise the page position in the address is honoured.
  const readPage = (page: RecordsTablePageRequest | undefined) =>
    read.services.tables.resolve(read.session, read.selection, {
      moduleRootId: bound.module.rootId,
      queryId: bound.query.queryId,
      settings: placementSettingsOf(placement),
      titleFieldId: String(titleFieldId),
      inputValues,
      fieldLabels: fieldLabelsOf(bound.module),
      fieldChoiceLabels: fieldChoiceLabelsOf(bound.module),
      fieldDateTypes: fieldDateTypesOf(bound.module),
      fieldLinkTypes: fieldLinkTypesOf(bound.module),
      filterTargets,
      ...(contract.features.inlineEdit.enabled || contract.features.rowEdit.enabled
        ? { fieldEditors: fieldEditorsOf(bound.module, read.context.releaseSet.modules) }
        : {}),
      ...(decide === undefined ? {} : { decide }),
      ...(timeZone === undefined ? {} : { timeZone }),
      resolveRecordLinks: read.services.resolveRecordLinks,
      state: { ...effectiveState, page },
      layout,
      ...(formatting === undefined ? {} : { formatting }),
      ...(tree === undefined ? {} : { tree }),
      ...(group === undefined ? {} : { group }),
    });
  const fromAddress =
    (explicitRequest === undefined && addressed.state.page !== undefined) ||
    (explicitRequest !== undefined && continuation?.fromAddress === true);
  let resolved = await readPage(
    level !== undefined
      ? {
          page: level.continuationToken === undefined ? 1 : 2,
          pageDirection: "forward",
          ...(level.continuationToken === undefined
            ? {}
            : { continuationToken: level.continuationToken }),
        }
      : groupMembers !== undefined
        ? {
            page: groupMembers.continuationToken === undefined ? 1 : 2,
            pageDirection: groupMembers.direction ?? "forward",
            ...(groupMembers.continuationToken === undefined
              ? {}
              : { continuationToken: groupMembers.continuationToken }),
          }
        : group !== undefined
          ? undefined
          : (explicitRequest ?? addressed.state.page),
  );
  // A shared link opened by another account, or after an access, release, sort, filter or column
  // change, no longer matches its sealed cursor (invalid or stale): it opens the first page
  // without an error.
  if (
    fromAddress &&
    resolved.kind === "refused" &&
    (resolved.reasonCode === "cursor_invalid" || resolved.reasonCode === "cursor_stale")
  ) {
    console.warn(
      `[page] table page address reopened at page one: application=${address.application.key} page=${address.pageKey} placement=${placementId} cause=${resolved.reasonCode}`,
    );
    resolved = await readPage(undefined);
  }
  if (resolved.kind === "unavailable") {
    console.error(
      "[page] data placement unavailable: class=protected_query code=query_unavailable",
    );
    data[placementId] = { status: "error" };
  } else if (resolved.kind === "refused") {
    console.error(
      `[page] data placement refused: class=${resolved.reasonCode === undefined ? "records_table" : "protected_query"} code=${resolved.reasonCode ?? "query_refused"}`,
    );
    // A date group that left the supported years, and a filter or sort the table cannot apply, has
    // its own business sentence.
    data[placementId] = {
      status: "refused",
      reason:
        resolved.reasonCode === "value_out_of_range" ||
        resolved.reasonCode === "dataset_limit_exceeded"
          ? resolved.reasonCode
          : resolved.reasonCode === "field_unbounded" && queryGrouped
            ? "grouping_unavailable"
            : (resolved.refusalReason ?? "not_permitted"),
    };
  } else if (resolved.display.status === "empty") data[placementId] = { status: "empty" };
  else {
    const values = resolved.display.values;
    // Bulk actions may run over every matching record, an export over the shown rows, and the
    // status bar totals the shown rows: the read seals what it matched (release, resolved inputs
    // and query state minus the page) for this viewer, with no extra read.
    const seal = read.services.tables.sealSelection;
    const selectionToken =
      seal === undefined ||
      (values.features?.bulkActions === undefined &&
        values.features?.export === undefined &&
        values.features?.spreadsheet?.statusBar === undefined)
        ? undefined
        : seal({
            installationRevision: read.context.applicationReleaseRevision,
            pageId: String(read.pageDefinition.pageId),
            placementId,
            moduleRootId: String(bound.module.rootId),
            queryId: String(bound.query.queryId),
            inputValues,
            state: {
              sort: effectiveState.sort,
              filters: effectiveState.filters,
              search: effectiveState.search,
            },
            ...(timeZone === undefined ? {} : { timeZone }),
          });
    data[placementId] = readyPlacementData(
      read.address,
      placementId,
      tableReadValuesSchema,
      selectionToken === undefined ? values : { ...values, selectionToken },
    );
  }
};
