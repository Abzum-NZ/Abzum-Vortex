"use client";
import { definitionLimits, type ApplicationSourceDocument } from "@vortex/platform/schema";
import { StudioInspectorGroup } from "@vortex/ui/studio";
import { StudioLimitRow } from "./studio-limit";

type Source = ApplicationSourceDocument;

/** The share of a limit from which the group opens by itself. */
const nearShare = 0.8;

/**
 * The usage of the limits that apply to one record type: its fields, its sortable fields (with a
 * link to list them) and its pipelines. The group opens on its own once any of them nears its limit.
 */
export function StudioRecordLimits({
  source,
  moduleKey,
  recordKey,
  onShowSortable,
}: Readonly<{
  source: Source;
  moduleKey: string;
  recordKey: string;
  onShowSortable: () => void;
}>) {
  const record = source.body.modules
    .find((module) => module.key === moduleKey)
    ?.record_types.find((item) => item.key === recordKey);
  if (record === undefined) return null;
  const sortable = record.fields.filter((field) => field.sortable).length;
  const rows = [
    { limit: "fieldsPerRecordType", used: record.fields.length },
    { limit: "sortableFieldsPerRecordType", used: sortable },
    { limit: "pipelinesPerRecordType", used: record.pipelines.length },
  ] as const;
  const near = rows.some((row) => row.used >= definitionLimits[row.limit] * nearShare);
  const full = rows.filter((row) => row.used >= definitionLimits[row.limit]);
  return (
    <StudioInspectorGroup
      title="Limits"
      defaultOpen={near}
      summary={
        full.length === 0
          ? undefined
          : full
              .map((row) => `${limitName[row.limit]} ${row.used} of ${definitionLimits[row.limit]}`)
              .join(" · ")
      }
    >
      <div className="space-y-1.5">
        <StudioLimitRow label="Fields" limit="fieldsPerRecordType" used={record.fields.length} />
        <StudioLimitRow
          label="Sortable fields"
          limit="sortableFieldsPerRecordType"
          used={sortable}
          action={{ label: "Show me", onSelect: onShowSortable }}
        />
        <StudioLimitRow
          label="Pipelines"
          limit="pipelinesPerRecordType"
          used={record.pipelines.length}
        />
      </div>
    </StudioInspectorGroup>
  );
}

const limitName = {
  fieldsPerRecordType: "Fields",
  sortableFieldsPerRecordType: "Sortable fields",
  pipelinesPerRecordType: "Pipelines",
} as const;

/** The usage of the limits that apply to one module: its record types, queries, actions and events. */
export function StudioModuleLimits({
  source,
  moduleKey,
}: Readonly<{ source: Source; moduleKey: string }>) {
  const module = source.body.modules.find((item) => item.key === moduleKey);
  if (module === undefined) return null;
  return (
    <StudioInspectorGroup title="Limits" defaultOpen={false}>
      <div className="space-y-1.5">
        <StudioLimitRow
          label="Record types"
          limit="recordTypesPerModule"
          used={module.record_types.length}
        />
        <StudioLimitRow label="Queries" limit="queriesPerModule" used={module.queries.length} />
        <StudioLimitRow label="Actions" limit="actionsPerModule" used={module.actions.length} />
        <StudioLimitRow label="Events" limit="eventsPerModule" used={module.events.length} />
      </div>
    </StudioInspectorGroup>
  );
}
