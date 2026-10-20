import "server-only";

import { readRecordsTableContract } from "../../schema";
import {
  protectedQueryGroupingSchema,
  protectedQueryGroupSelectorSchema,
  type ProtectedQueryPage,
  type ProtectedQueryRefusalReasonCode,
} from "../../queries/index";
import type { RecordsTableQueryCommand, RecordsTableQueryRequest, RecordsTableQueryRunner } from "../records-table-query";
import type { IdentitySession, OrganizationSelectionCandidate } from "../../schema";

/** Only a bounded summary page and the single open group's member page travel to the browser. */
export type RecordsTableGroupingProjection = Readonly<{
  label: string;
  groups: readonly Readonly<{ key: string; label: string; count: number }>[];
  active: string | null;
  after: string | null;
  next: string | null;
}>;

export const readRecordsTableGroups = async (
  runner: RecordsTableQueryRunner,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  request: RecordsTableQueryRequest,
  built: RecordsTableQueryCommand,
): Promise<
  | Readonly<{ kind: "available"; page: ProtectedQueryPage; grouping: RecordsTableGroupingProjection }>
  | Readonly<{ kind: "refused"; reasonCode?: ProtectedQueryRefusalReasonCode }>
  | Readonly<{ kind: "unavailable" }>
> => {
  const feature = readRecordsTableContract(request.settings)?.features.grouping;
  if (feature === undefined || !feature.enabled || feature.field === undefined)
    return { kind: "refused" };
  const fieldId = feature.field.toLowerCase();
  const dateType = request.fieldDateTypes?.[fieldId];
  const fieldType = dateType ?? (request.fieldChoiceLabels?.[fieldId] === undefined ? undefined : "choice");
  if (fieldType === undefined) return { kind: "refused" };
  const grouping = protectedQueryGroupingSchema.safeParse({
    fieldId, limit: feature.limit,
    ...(dateType === undefined ? {} : { dateBucket: { unit: feature.unit, timeZone: feature.timeZone } }),
  });
  if (!grouping.success) return { kind: "refused" };
  const command = built.command;
  const summary = await runner.summarise(session, selection, {
    moduleRootId: command.moduleRootId, queryId: command.queryId, inputValues: command.inputValues,
    grouping: grouping.data,
    ...(request.state.grouping?.after === undefined ? {} : { groupAfter: request.state.grouping.after }),
    filter: command.filter, search: command.search,
    filterableFieldIds: command.filterableFieldIds, searchableFieldIds: command.searchableFieldIds,
  });
  if (summary.kind === "temporarily_unavailable") return { kind: "unavailable" };
  if (summary.kind !== "available") return { kind: "refused" };
  if (summary.value.outcome === "refused") return { kind: "refused", reasonCode: summary.value.reasonCode };
  const groups = summary.value.groups;
  const active = request.state.grouping?.active;
  // A selector is accepted only from the current visible summary page, after its live access check.
  const chosen = active === undefined ? undefined : groups.find((group) => group.groupKey === active);
  if (active !== undefined && chosen === undefined) return { kind: "refused" };
  const projection: RecordsTableGroupingProjection = {
    label: request.fieldLabels?.[fieldId] ?? "Groups",
    groups: groups.map((group) => {
      const value = group.groupValues[fieldId];
      const label = value === null ? "Not set"
        : fieldType === "choice"
          ? request.fieldChoiceLabels?.[fieldId]?.find((option) => option.value === value)?.label
          : fieldType === "date" ? String(value)
            : new Intl.DateTimeFormat("en", { timeZone: feature.timeZone, year: "numeric", month: "short", day: "numeric" }).format(new Date(String(value)));
      if (label === undefined) throw new Error("GROUP_LABEL_INVALID");
      return { key: group.groupKey, label, count: group.rowCount };
    }),
    active: active ?? null,
    after: request.state.grouping?.after ?? null,
    next: summary.value.nextGroupKey ?? null,
  };
  if (chosen === undefined)
    return { kind: "available", grouping: projection, page: {
      outcome: "completed", moduleRootId: command.moduleRootId, queryId: command.queryId,
      moduleReleaseVersion: summary.value.moduleReleaseVersion, rows: [], fieldBounds: summary.value.fieldBounds,
    } };
  const selector = protectedQueryGroupSelectorSchema.safeParse({ values: [{ fieldId, fieldType, value: chosen.groupValues[fieldId] }] });
  if (!selector.success) throw new Error("GROUP_SELECTOR_INVALID");
  const members = await runner.groupedMembers(session, selection, { ...command, grouping: grouping.data, selector: selector.data });
  if (members.kind === "temporarily_unavailable") return { kind: "unavailable" };
  if (members.kind !== "available") return { kind: "refused" };
  if (members.value.outcome === "refused") return { kind: "refused", reasonCode: members.value.reasonCode };
  const { groupByFieldIds: _fields, groupValues: _values, ...page } = members.value;
  return { kind: "available", page, grouping: projection };
};
