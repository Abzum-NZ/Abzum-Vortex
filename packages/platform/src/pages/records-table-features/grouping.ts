import "server-only";

import type { JsonValue } from "../../catalogue/common";
import type { RecordsTableGroupingFieldType } from "../../definition/application-composition/records-table-features/grouping";
import {
  UnreadableSettingError,
  type RecordsTablePivotDateUnit,
} from "../../definition/application-composition/records-table-features/shared";
import type { ProtectedQuerySummaryCompleted } from "../../queries/protected-query-contracts";
import {
  collectRecordLinkValues,
  recordLinkPlainText,
  type ProjectedRecordLinks,
  type ProjectedTableGroup,
  type ProjectedTableGroups,
} from "../component-data-projection";
import {
  parseRecordsTableGroupKey,
  recordsTableGroupKey,
  type RecordsTableGroupValue,
} from "../records-table-state";
import { projectRecordsTableTotals, type RecordsTableTotalRead } from "./totals";
import { bucketFirstDay, bucketLabel } from "./dimension-values";

/** The one group of links whose target the viewer cannot read: it carries no identity or title. */
const NOT_AVAILABLE = "not_available";

/**
 * How a grouped table is read. `fieldId` is the authored grouping field (lower-case) of the given
 * type; a date field is bucketed by `dateUnit` in `timeZone`, the organisation's calendar zone read
 * for this request. `pageSize` is how many groups one page shows and `after` the position of the
 * page before (null for the first). `expanded` is the group key of the open group, or null while
 * every group is closed. `membersOnly` reads one page of the open group's members and no summary:
 * opening or paging a group never counts the groups again.
 */
export type RecordsTableGroupRead = Readonly<{
  fieldId: string;
  fieldType: RecordsTableGroupingFieldType;
  dateUnit?: RecordsTablePivotDateUnit;
  timeZone?: string;
  pageSize: number;
  after: string | null;
  unassignedLabel: string;
  expanded: string | null;
  membersOnly: boolean;
  /**
   * The table reads a grouped query, so it has no flat rows: when its groups cannot be counted
   * for this viewer it is refused instead of read flat.
   */
  required: boolean;
}>;

/** The typed selector that names one group's members: the group's value in the field's own type. */
export const recordsTableGroupSelector = (
  fieldId: string,
  fieldType: RecordsTableGroupingFieldType,
  key: string,
):
  | Readonly<{
      values: readonly [{ fieldId: string; fieldType: string; value: JsonValue }];
    }>
  | undefined => {
  const value = parseRecordsTableGroupKey(key);
  if (value === undefined) return undefined;
  // A key is only valid for the type of field the table is grouped by.
  if (typeof value === "object" && value !== null && fieldType !== "link") return undefined;
  return { values: [{ fieldId, fieldType, value }] };
};

/** The group value a summary group holds for the grouping field, or undefined when it is malformed. */
const groupValueOf = (
  groupValues: Readonly<Record<string, JsonValue>>,
  field: Pick<RecordsTableGroupRead, "fieldId" | "fieldType">,
): RecordsTableGroupValue | undefined => {
  const value = Object.entries(groupValues).find(
    ([fieldId]) => fieldId.toLowerCase() === field.fieldId,
  )?.[1];
  if (value === undefined || value === null) return value;
  if (field.fieldType === "link") {
    if (value === NOT_AVAILABLE) return NOT_AVAILABLE;
    const [link] = collectRecordLinkValues([value]);
    return link === undefined
      ? undefined
      : { recordTypeId: link.recordTypeId.toLowerCase(), recordId: link.recordId.toLowerCase() };
  }
  return typeof value === "string" ? value : undefined;
};

/** The keys of the summary's groups in the order it returned them, or undefined when one is malformed. */
export const recordsTableSummaryGroupKeys = (
  summary: ProtectedQuerySummaryCompleted,
  field: Pick<RecordsTableGroupRead, "fieldId" | "fieldType">,
): readonly string[] | undefined => {
  const keys: string[] = [];
  for (const group of summary.groups) {
    const value = groupValueOf(group.groupValues, field);
    if (value === undefined) return undefined;
    keys.push(recordsTableGroupKey(value));
  }
  return keys;
};

/** The links the summary's groups name, to be titled in the same batched read as the page's links. */
export const recordsTableGroupLinks = (
  summary: ProtectedQuerySummaryCompleted,
  field: Pick<RecordsTableGroupRead, "fieldId" | "fieldType">,
) =>
  field.fieldType !== "link"
    ? []
    : collectRecordLinkValues(
        summary.groups.flatMap((group) => {
          const value = groupValueOf(group.groupValues, field);
          return value === undefined || value === null || typeof value === "string" ? [] : [value];
        }),
      );

/**
 * The groups a summary counted, in the order the summary returned them: the server orders and pages
 * them, so every page continues the previous one. A choice's group is labelled with its choice's
 * label (or the stored value when the choice is no longer offered) and comes in the field's option
 * order, a value no longer offered after every option; a link's group is its target's readable
 * title, titled groups first, then no value, then Not available; a date's group is the heading of
 * its calendar bucket. For a choice the records that hold no value come last. A label is never a
 * count of loaded rows: every count comes from the same summary read.
 */
export const projectRecordsTableGroups = (
  summary: ProtectedQuerySummaryCompleted,
  field: RecordsTableGroupRead &
    Readonly<{ options: readonly Readonly<{ value: string; label: string }>[] }>,
  recordLinks: ProjectedRecordLinks | undefined,
  totals: readonly RecordsTableTotalRead[],
): ProjectedTableGroups | undefined => {
  const groups: ProjectedTableGroup[] = [];
  for (const group of summary.groups) {
    const value = groupValueOf(group.groupValues, field);
    if (value === undefined) return undefined;
    const key = recordsTableGroupKey(value);
    if (groups.some((held) => held.key === key)) return undefined;
    groups.push({
      key,
      label: groupLabel(value, field, recordLinks),
      count: group.rowCount,
      ...(totals.length === 0
        ? {}
        : { totals: projectRecordsTableTotals(totals, group.aggregates) }),
      ...(value === null ? { unassigned: true as const } : {}),
    });
  }
  const next = summary.nextGroupKey ?? undefined;
  return {
    status: "ready",
    fieldId: field.fieldId,
    groups,
    total: summary.totalRowCount,
    page: { first: field.after === null, ...(next === undefined ? {} : { next }) },
    ...(field.expanded !== null && groups.some((group) => group.key === field.expanded)
      ? { expanded: field.expanded }
      : {}),
  };
};

const groupLabel = (
  value: RecordsTableGroupValue,
  field: RecordsTableGroupRead &
    Readonly<{ options: readonly Readonly<{ value: string; label: string }>[] }>,
  recordLinks: ProjectedRecordLinks | undefined,
): string => {
  if (value === null) return field.unassignedLabel;
  if (field.fieldType === "choice")
    return field.options.find((option) => option.value === value)?.label ?? String(value);
  if (field.fieldType === "link")
    return typeof value === "string"
      ? "Not available"
      : (recordLinkPlainText(value, recordLinks) ?? "Not available");
  // Publication refuses a grouped date field without its calendar unit, so a read that has none is
  // a defect in what was published, never a unit to guess.
  if (field.dateUnit === undefined) throw new UnreadableSettingError("features.grouping.date_unit");
  return bucketLabel(
    bucketFirstDay(field.fieldType, String(value), field.timeZone),
    field.dateUnit,
  );
};
