import {
  recordsTableEditableFieldTypes,
  type RecordsTableFeatureKey,
  type RecordsTableQueryFacts,
} from "@vortex/platform/schema";
import type {
  StudioActionChoice,
  StudioQueryChoice,
  StudioRelationshipChoice,
} from "../contextual-palette";

/**
 * How Studio edits one grid feature's settings once it is switched on. `settings` draws the feature's
 * declared settings with Studio's one set of typed setting controls (fields are picked from the bound
 * query by business name); a feature with its own editor registers `{ kind: "custom" }` here and the
 * Features panel draws that editor.
 * Every feature of the Records table registry has exactly one entry, so the Features panel never
 * meets a feature it cannot show.
 */
export type StudioGridFeatureEditor = Readonly<{ kind: "settings" }> | Readonly<{ kind: "custom" }>;

export const studioGridFeatureEditors: Readonly<
  Record<RecordsTableFeatureKey, StudioGridFeatureEditor>
> = {
  search: { kind: "settings" },
  column_filters: { kind: "settings" },
  saved_views: { kind: "settings" },
  bulk_actions: { kind: "settings" },
  inline_edit: { kind: "settings" },
  conditional_formatting: { kind: "custom" },
};

/**
 * The bound query's facts as the draft holds them, in the spelling the table's settings use
 * (qualified field references), so Studio runs the same feature check publication runs on the
 * compiled release. A query that is not chosen yet offers nothing.
 */
export const studioRecordsTableQueryFacts = (
  query: StudioQueryChoice | undefined,
  actions: readonly StudioActionChoice[],
  relationships: readonly StudioRelationshipChoice[],
): RecordsTableQueryFacts => ({
  recordTypeLabel: query?.label ?? "",
  fields: (query?.fields ?? []).map((field) => ({
    field: field.reference,
    label: field.label,
    type: field.type,
    sortable: field.sortable,
    filterable: field.filterable,
    searchable: field.searchable,
    editable: query?.grouped !== true && recordsTableEditableFieldTypes.includes(field.type),
    ...(field.choiceCount === undefined ? {} : { choiceCount: field.choiceCount }),
    ...(field.resultType === undefined ? {} : { resultType: field.resultType }),
  })),
  relationships: relationships
    .filter((relationship) => relationship.recordType === query?.recordType)
    .map((relationship) => ({ key: relationship.reference, label: relationship.label })),
  actions: actions.map((action) => ({ key: action.reference, label: action.label })),
  grouped: query?.grouped === true,
});
