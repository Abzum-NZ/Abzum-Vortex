import { z } from "zod";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

/** Pinning changes only layout; it never requests another field or row. */
export type RecordsTablePinningSettings = Readonly<Record<never, never>>;

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "pinning",
  label: "Column pinning",
  help: "Keep columns in view while scrolling; set each column's default pin in Columns",
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
      help: "Allow start and end column pinning",
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
  code: "definition_records_table_pinning",
  order: 39,
  message: "Column pinning needs a field from the bound query.",
  guidance: "Choose a query with fields, then set each column's pin position in Columns.",
};

const projectionSchema = z.literal(true);

export const recordsTablePinningFeature: RecordsTableFeatureDefinition<
  RecordsTablePinningSettings,
  "pinning"
> &
  Readonly<{ property: "pinning"; projectionSchema: typeof projectionSchema }> = {
  key: "pinning",
  property: "pinning",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  label: "Column pinning",
  description: "Keep columns at the start or end while scrolling; choose defaults in Columns",
  read: (group) => ({ enabled: featureEnabled(group) }),
  conflicts: (_state, _facts, { presentation }) =>
    presentation === "cards"
      ? featureNotPossible(
          featureRefusal,
          "Column pinning needs the Table preset. Lists have no scrolling columns.",
        )
      : undefined,
  project: (state) => (state.enabled ? true : undefined),
  check: (_state, facts) =>
    facts.fields.length > 0 ? featureAvailable : featureNotPossible(featureRefusal),
};
