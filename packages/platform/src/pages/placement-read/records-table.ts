import "server-only";

import {
  describeFailure,
  recordsTableGroupingFieldTypes,
  sameId,
  type JsonValue,
  type RecordsTableContract,
  type RecordsTableGroupingFieldType,
} from "../../schema";
import {
  decodeRecordsTableFieldFilter,
  readRecordsTableQueryState,
  readRecordsTableView,
  type RecordsTablePageRequest,
  type RecordsTableQueryState,
} from "../records-table-state";
import {
  authoredGridLayout,
  addressedDefaultGridViews,
  gridViewLayout,
  resolveGridLayout,
  resolveSelectedGridView,
  type GridLayoutState,
  type GridViewsState,
} from "../grid-view-state";
import { addressedGridView, gridViewPlacement } from "../grid-views";
import type { RecordsTableGroupRead } from "../records-table-features/grouping";
import {
  conditionalFormattingRelativeDates,
  conditionalFormattingUsesRelativeDates,
  personalFormattingAllowed,
  personalFormattingRules,
  type ConditionalFormattingContext,
} from "../records-table-features";
import {
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
const filterTimeZone = async (
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
  const addressed = readRecordsTableQueryState(placementId, addressEntries);
  if (addressed.kind === "malformed") {
    logPlacementFailure(address, placementId, "table_state_malformed", addressed.part);
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const queryId = String(bound.query.queryId).toLowerCase();
  const recordType = bound.query.recordType;
  const readable =
    gridLayouts.readable === undefined
      ? undefined
      : (gridLayouts.readable.get(
          recordType.state === "resolved" ? String(recordType.recordTypeId).toLowerCase() : "",
        ) ?? new Set<string>());
  const authored = authoredGridLayout(contract, readable);
  if (authored === undefined) {
    logPlacementFailure(address, placementId, "table_columns_withheld");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const stored = gridLayouts.stored.layouts.get(placementId.toLowerCase());
  // Saved views: the person's list, and the one the address selected re-evaluated under their
  // access (a column or filter they cannot see is left out and counted).
  let views: GridViewsState | undefined;
  let selectedQuery: RecordsTableQueryState | undefined;
  let selectedLayout: GridLayoutState["layout"] | undefined;
  if (contract.features.savedViews.enabled && gridLayouts.storage === "personal") {
    const listed = (gridLayouts.stored.views.get(placementId.toLowerCase()) ?? []).filter(
      (view) => view.queryId === queryId,
    );
    const installedViews = gridViewPlacement(read.pageDefinition, placementId)?.contract.features
      .savedViews;
    if (installedViews?.enabled !== true) throw new Error("GRID_DEFAULT_VIEWS_NOT_INSTALLED");
    const defaults = addressedDefaultGridViews(
      installedViews.defaultViews,
      gridLayouts.stored.roleKeys,
      gridLayouts.stored.defaultDocuments,
    );
    const addressedView = readRecordsTableView(placementId, addressEntries);
    const automatic =
      stored === undefined && addressedView === undefined
        ? defaults.find((view) => view.isDefault)
        : undefined;
    const view =
      addressedView ??
      (automatic === undefined ? undefined : { viewId: automatic.viewId, cleared: false });
    const resolvedView =
      view === undefined
        ? { selected: null, notice: null }
        : resolveSelectedGridView(
            authored,
            defaults.find((candidate) => candidate.viewId === view.viewId) ??
              addressedGridView(
                listed,
                queryId,
                view.viewId,
                gridLayouts.stored.shareable.has(placementId.toLowerCase()),
              ),
            readable,
            personalFormattingAllowed(contract),
          );
    views = {
      canShare: gridLayouts.stored.shareable.has(placementId.toLowerCase()),
      items: [
        ...defaults.map((view) => view.item),
        ...listed.map(({ viewId: id, name, scope, mine, revision }) => ({
          viewId: id,
          name,
          scope,
          mine,
          revision,
        })),
      ],
      basedOnViewId: stored?.basedOnViewId ?? null,
      selected: resolvedView.selected,
      notice: resolvedView.notice,
      ...(installedViews.personalFormatting && contract.features.conditionalFormatting.enabled
        ? {
            formattingFields: (
              bound.module.content.recordTypes.find(
                (candidate) =>
                  recordType.state === "resolved" &&
                  String(candidate.recordTypeId).toLowerCase() ===
                    String(recordType.recordTypeId).toLowerCase(),
              )?.fields ?? []
            ).filter((field) =>
              authored.columns.some(
                (column) => column.fieldId === String(field.fieldId).toLowerCase(),
              ),
            ),
          }
        : {}),
    };
    const selected = resolvedView.selected;
    if (selected !== null) {
      // The address wins: a view's own sort, filters and search apply only when the address names
      // none and the person has not cleared them.
      if (
        view?.cleared === false &&
        addressed.state.sort.length === 0 &&
        addressed.state.filters.length === 0 &&
        addressed.state.search === null
      )
        selectedQuery = {
          ...addressed.state,
          sort: selected.document.sort ?? [],
          filters: (selected.document.filters ?? []).flatMap(({ fieldId, filter }) => {
            const typed = decodeRecordsTableFieldFilter(filter);
            return typed === undefined ? [] : [{ fieldId, filter: typed }];
          }),
          search: selected.document.search ?? null,
        };
      // A layout the person arranged from this view is theirs; otherwise the view's shows.
      if (stored?.basedOnViewId !== selected.viewId)
        selectedLayout = gridViewLayout(selected.document);
    }
  }
  const resolvedLayout =
    selectedLayout !== undefined
      ? { layout: selectedLayout, reset: false }
      : resolveGridLayout(
          authored,
          stored?.layout === undefined
            ? undefined
            : { queryId: stored.queryId, layout: stored.layout },
          queryId,
        );
  const layout: GridLayoutState = {
    storage: gridLayouts.storage,
    queryId,
    revision: stored?.revision ?? null,
    layout: resolvedLayout.layout,
    authored,
    reset: resolvedLayout.reset,
    ...(views === undefined ? {} : { views }),
  };
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
        }
      : undefined;
  // Export is projected only for a viewer whose export permission reaches every record; the
  // permission is decided in this read and again by the export route on every request.
  const exportAllowed =
    contract.features.export.enabled && recordType.state === "resolved"
      ? await read.services.exportAllowed(read.context, String(recordType.recordTypeId))
      : undefined;
  const effectiveState = selectedQuery ?? addressed.state;
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
      inputValues,
      fieldLabels: fieldLabelsOf(bound.module),
      fieldChoiceLabels: fieldChoiceLabelsOf(bound.module),
      fieldDateTypes: fieldDateTypesOf(bound.module),
      fieldLinkTypes: fieldLinkTypesOf(bound.module),
      filterTargets,
      ...(contract.features.inlineEdit.enabled || contract.features.rowEdit.enabled
        ? { fieldEditors: fieldEditorsOf(bound.module, read.context.releaseSet.modules) }
        : {}),
      ...(exportAllowed === undefined ? {} : { exportAllowed }),
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
    // A date group that left the supported years has its own business sentence.
    data[placementId] = {
      status: "refused",
      reason: resolved.reasonCode === "value_out_of_range" ? "value_out_of_range" : "not_permitted",
    };
  } else if (resolved.display.status === "empty") data[placementId] = { status: "empty" };
  else {
    let values = resolved.display.values;
    if (values.features?.rowActions !== undefined) {
      if (bound.query.recordType.state !== "resolved")
        throw new Error("ROW_ACTION_RECORD_TYPE_UNRESOLVED");
      const rowActions = await read.services.tables.projectRowActions(
        read.context,
        placementId,
        String(bound.query.recordType.recordTypeId),
        values.features.rowActions,
      );
      values = { ...values, features: { ...values.features, rowActions } };
    }
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
    data[placementId] = {
      status: "ready",
      values: selectionToken === undefined ? values : { ...values, selectionToken },
    };
  }
};
