import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** Pinning changes only layout; it never requests another field or row. */
export type RecordsTablePinningSettings = Readonly<Record<never, never>>;

export const recordsTablePinningFeature: RecordsTableFeatureDefinition<RecordsTablePinningSettings> =
  {
    key: "pinning",
    label: "Column pinning",
    description: "Keep columns at the start or end while scrolling; choose defaults in Columns",
    read: (group) => ({ enabled: featureEnabled(group) }),
    check: (_state, facts) =>
      facts.fields.length > 0
        ? featureAvailable
        : featureNotPossible("definition_records_table_pinning"),
  };
