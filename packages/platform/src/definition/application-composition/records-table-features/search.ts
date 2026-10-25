import { z } from "zod";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

/** Search: one search box over the fields the record type marks searchable. It has no settings. */
export type RecordsTableSearchSettings = Readonly<Record<never, never>>;

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "search",
  label: "Search",
  help: "A search box over the searchable fields of the bound query",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "On",
      help: "Show a search box",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_search",
  order: 36,
  message: "Search needs a searchable text field in the bound query.",
  guidance:
    "Select a text field the record type marks searchable in the query, or turn Search off.",
};

const projectionSchema = z.literal(true);

export const recordsTableSearchFeature: RecordsTableFeatureDefinition<
  RecordsTableSearchSettings,
  "search"
> &
  Readonly<{ property: "search"; projectionSchema: typeof projectionSchema }> = {
  key: "search",
  property: "search",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  events: { search_changed: {} },
  label: "Search",
  description: "A search box over the searchable fields",
  read: (group) => ({ enabled: featureEnabled(group) }),
  // The Query engine searches only the selected fields the record type marks searchable.
  // Offered only when the viewer can read some field the record type marks searchable.
  project: (state, { searchable }) => (state.enabled && searchable ? true : undefined),
  check: (_state, facts) =>
    facts.fields.some((field) => field.searchable)
      ? featureAvailable
      : featureNotPossible(featureRefusal),
};
