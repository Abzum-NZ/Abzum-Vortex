import "server-only";

import type { JsonValue } from "../../schema";
import type { ProtectedQuerySummaryCompleted } from "../../queries/index";
import type { ProjectedTableGroup, ProjectedTableGroups } from "../component-data-projection";
import { parseRecordsTableGroupKey, recordsTableGroupKey } from "../records-table-state";

/** The most groups one grouped read returns; a choice field offers at most 50 and one more holds no value. */
export const RECORDS_TABLE_GROUP_READ_LIMIT = 200;

/**
 * How a grouped table is read. `fieldId` is the authored choice field (lower-case) and `expanded`
 * the group key of the open group, or null while every group is closed. `membersOnly` reads one
 * page of the open group's members and no summary: opening or paging a group never counts the
 * groups again.
 */
export type RecordsTableGroupRead = Readonly<{
  fieldId: string;
  unassignedLabel: string;
  expanded: string | null;
  membersOnly: boolean;
}>;

/** The typed selector that names one group's members: a choice value, or null for records with none. */
export const recordsTableGroupSelector = (
  fieldId: string,
  key: string,
):
  | Readonly<{ values: readonly [{ fieldId: string; fieldType: "choice"; value: JsonValue }] }>
  | undefined => {
  const value = parseRecordsTableGroupKey(key);
  return value === undefined ? undefined : { values: [{ fieldId, fieldType: "choice", value }] };
};

/**
 * The groups a summary counted, in the field's choice order with the records that hold no value
 * last. A group's label is its choice's label (or the stored value when the choice is no longer
 * offered) and never a count of loaded rows: every count comes from the same summary read.
 */
export const projectRecordsTableGroups = (
  summary: ProtectedQuerySummaryCompleted,
  field: Readonly<{
    fieldId: string;
    unassignedLabel: string;
    options: readonly Readonly<{ value: string; label: string }>[];
  }>,
  expanded: string | null,
): ProjectedTableGroups | undefined => {
  const groups: ProjectedTableGroup[] = [];
  for (const group of summary.groups) {
    const value = Object.entries(group.groupValues).find(
      ([fieldId]) => fieldId.toLowerCase() === field.fieldId,
    )?.[1];
    if (value === undefined || (value !== null && typeof value !== "string")) return undefined;
    const key = recordsTableGroupKey(value);
    if (groups.some((held) => held.key === key)) return undefined;
    const option = value === null ? undefined : field.options.find((o) => o.value === value);
    groups.push({
      key,
      label: value === null ? field.unassignedLabel : (option?.label ?? value),
      count: group.rowCount,
      ...(value === null ? { unassigned: true as const } : {}),
    });
  }
  const rank = (group: ProjectedTableGroup): number => {
    if (group.unassigned === true) return Number.MAX_SAFE_INTEGER;
    const value = parseRecordsTableGroupKey(group.key);
    const index = field.options.findIndex((option) => option.value === value);
    return index < 0 ? field.options.length : index;
  };
  groups.sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label));
  return {
    status: "ready",
    fieldId: field.fieldId,
    groups,
    total: summary.totalRowCount,
    ...(expanded !== null && groups.some((group) => group.key === expanded) ? { expanded } : {}),
  };
};
