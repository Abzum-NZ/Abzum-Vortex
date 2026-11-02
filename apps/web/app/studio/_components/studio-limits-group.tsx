"use client";
import {
  definitionLimitNear,
  definitionLimitReached,
  definitionLimitUsage,
  type ApplicationSourceDocument,
  type CountedLimit,
} from "@vortex/platform/schema";
import { StudioInspectorGroup } from "@vortex/ui/studio";
import { StudioLimitRow } from "./studio-limit";

type Source = ApplicationSourceDocument;

type Row = Readonly<{
  label: string;
  limit: CountedLimit;
  used: number;
  action?: Readonly<{ label: string; onSelect: () => void }>;
}>;

/**
 * The usage of the limits that apply to one owner, in one group. The group opens on its own once
 * any of them nears its limit (its open state is never remembered: a remembered "closed" would hide
 * exactly the group that matters), and its summary names the limits that are full.
 */
function StudioLimitsGroup({ title, rows }: Readonly<{ title: string; rows: readonly Row[] }>) {
  const near = rows.some((row) => definitionLimitNear(row.limit, row.used));
  const full = rows.filter((row) => definitionLimitReached(row.limit, row.used));
  return (
    <StudioInspectorGroup
      title={title}
      persist={false}
      defaultOpen={near}
      summary={
        full.length === 0
          ? undefined
          : full
              .map((row) => `${row.label} ${definitionLimitUsage(row.limit, row.used)}`)
              .join(" · ")
      }
    >
      <div className="space-y-1.5">
        {rows.map((row) => (
          <StudioLimitRow
            key={row.limit}
            label={row.label}
            limit={row.limit}
            used={row.used}
            {...(row.action === undefined ? {} : { action: row.action })}
          />
        ))}
      </div>
    </StudioInspectorGroup>
  );
}

/** The limits of one record type: its fields, what they allow, its relationships and pipelines. */
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
  return (
    <StudioLimitsGroup
      title="Record type limits"
      rows={[
        { label: "Fields", limit: "fieldsPerRecordType", used: record.fields.length },
        {
          label: "Sortable fields",
          limit: "sortableFieldsPerRecordType",
          used: record.fields.filter((field) => field.sortable).length,
          action: { label: "Show me", onSelect: onShowSortable },
        },
        {
          label: "Filterable fields",
          limit: "filterableFieldsPerRecordType",
          used: record.fields.filter((field) => field.filterable).length,
        },
        {
          label: "Searchable fields",
          limit: "searchableFieldsPerRecordType",
          used: record.fields.filter((field) => field.search_priority !== undefined).length,
        },
        {
          label: "Relationships",
          limit: "relationshipsPerRecordType",
          used: record.relationships.length,
        },
        { label: "Pipelines", limit: "pipelinesPerRecordType", used: record.pipelines.length },
      ]}
    />
  );
}

/** The limits of one module: what it holds of each kind. */
export function StudioModuleLimits({
  source,
  moduleKey,
}: Readonly<{ source: Source; moduleKey: string }>) {
  const module = source.body.modules.find((item) => item.key === moduleKey);
  if (module === undefined) return null;
  return (
    <StudioLimitsGroup
      title="Module limits"
      rows={[
        { label: "Record types", limit: "recordTypesPerModule", used: module.record_types.length },
        { label: "Queries", limit: "queriesPerModule", used: module.queries.length },
        { label: "Actions", limit: "actionsPerModule", used: module.actions.length },
        { label: "Events", limit: "eventsPerModule", used: module.events.length },
        { label: "Flows", limit: "flowsPerOwner", used: module.flows.length },
        {
          label: "Extension points",
          limit: "extensionPointsPerModule",
          used: module.extension_points.length,
        },
      ]}
    />
  );
}
