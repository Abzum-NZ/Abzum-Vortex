import type { RecordsTableFeatureProjection } from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { fail, requireArray, requireExactKeys, requireNonEmptyString, requireRecord } from "./projected-data";

export const parseTableGrouping = (value: unknown, location: DefinitionRenderErrorLocation): NonNullable<RecordsTableFeatureProjection["grouping"]> => {
  const record = requireRecord(value, "Projected groups are invalid", location);
  requireExactKeys(record, ["label", "groups", "active", "after", "next"], location);
  const key = (value: unknown): string | null => value === null ? null : requireNonEmptyString(value, "Projected group key is invalid", location);
  const groups = requireArray(record.groups, "Projected groups are invalid", location).map((value) => {
    const group = requireRecord(value, "Projected group is invalid", location);
    requireExactKeys(group, ["key", "label", "count"], location);
    if (typeof group.count !== "number" || !Number.isInteger(group.count) || group.count < 0 || group.count > 100_000)
      fail("Projected group count is invalid", location);
    return { key: requireNonEmptyString(group.key, "Projected group key is invalid", location), label: requireNonEmptyString(group.label, "Projected group label is invalid", location), count: group.count };
  });
  const active = key(record.active);
  if (groups.length > 200 || new Set(groups.map((group) => group.key)).size !== groups.length || (active !== null && !groups.some((group) => group.key === active)))
    fail("Projected groups are invalid", location);
  return { label: requireNonEmptyString(record.label, "Projected group label is invalid", location), groups, active, after: key(record.after), next: key(record.next) };
};
