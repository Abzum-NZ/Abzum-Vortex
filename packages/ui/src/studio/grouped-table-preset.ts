import {
  checkRecordsTableGrouping,
  groupingDefaultsFromQuery,
  readRecordsTableFeatures,
  type BlockPropertySchemaContract,
  type PlatformBlockRelease,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import type { StudioCompositionSettings } from "./application-composition-model";
import type { StudioQueryChoice } from "./contextual-palette";
import { studioGridFeatureStartSettings, studioGroupingFacts } from "./grid-features";

type GroupValue = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/** The Preset choice that makes a Data grid a Grouped table: a palette choice, never a stored value. */
export const STUDIO_GROUPED_TABLE_PRESET = "grouped";

/** The two settings of Group by a builder gives when adding a Grouped table. */
const presetSettingKeys: readonly string[] = ["field", "date_unit"];

/**
 * What a Grouped table writes: the catalogue's own declarations of Group by's field and calendar
 * unit (asked for when the block is added) and the default of the whole `features` setting it
 * switches Group by on in. A Grouped table is an ordinary grid with Group by on, so it writes
 * ordinary settings and is drawn by the one grid.
 */
export type StudioGroupedTablePreset = Readonly<{
  settings: readonly BlockPropertySchemaContract[];
  features: GroupValue;
}>;

/** The Grouped table preset of a Data grid release; undefined for a table release without Group by. */
export const studioGroupedTablePreset = (
  release: PlatformBlockRelease,
): StudioGroupedTablePreset | undefined => {
  if (release.key !== "platform.display.table") return undefined;
  const features = release.properties.find((property) => property.key === "features");
  if (features?.kind !== "group" || features.defaultValue?.kind !== "group") return undefined;
  const grouping = features.properties.find((property) => property.key === "grouping");
  if (grouping?.kind !== "group") return undefined;
  return {
    settings: grouping.properties.filter((property) => presetSettingKeys.includes(property.key)),
    features: features.defaultValue as GroupValue,
  };
};

/** The Preset control with the Grouped table choice beside Table and List. */
export const studioTablePresetProperty = (
  property: BlockPropertySchemaContract,
): BlockPropertySchemaContract =>
  property.kind === "choice"
    ? {
        ...property,
        options: [
          ...property.options,
          { key: STUDIO_GROUPED_TABLE_PRESET, label: "Grouped table" },
        ],
        help: "Table shows columns; List shows the same records as cards; Grouped table shows them in groups with a count for each",
      }
    : property;

/** What a Grouped table asks for at first: the field the bound query already groups by. */
export const studioGroupedTableStart = (
  query: StudioQueryChoice | undefined,
): StudioCompositionSettings => {
  const defaults = groupingDefaultsFromQuery(studioGroupingFacts(query));
  return defaults === undefined
    ? {}
    : {
        field: { kind: "field_reference", field: defaults.field },
        ...(defaults.dateUnit === undefined
          ? {}
          : { date_unit: { kind: "choice", value: defaults.dateUnit } }),
      };
};

/**
 * The settings a new Grouped table is added with, or the business sentence that says why the
 * chosen field cannot group the bound query: the sentence publication would give.
 */
export const studioGroupedTableSettings = (
  preset: StudioGroupedTablePreset,
  query: StudioQueryChoice | undefined,
  values: StudioCompositionSettings,
): Readonly<{ settings: StudioCompositionSettings }> | Readonly<{ problem: string }> => {
  const grouping = preset.features.properties["grouping"];
  if (grouping?.kind !== "group") throw new Error("The Group by feature has no catalogue default");
  const chosen = Object.fromEntries(
    Object.entries(values).filter(([key]) => presetSettingKeys.includes(key)),
  );
  const features: GroupValue = {
    ...preset.features,
    properties: {
      ...preset.features.properties,
      grouping: {
        ...grouping,
        properties: {
          ...grouping.properties,
          ...studioGridFeatureStartSettings.grouping,
          ...chosen,
          enabled: { kind: "boolean", value: true },
        },
      },
    },
  };
  const state = readRecordsTableFeatures(features)?.grouping;
  if (state === undefined) throw new Error("The Group by settings of the Data grid are invalid");
  const check = checkRecordsTableGrouping(state, studioGroupingFacts(query));
  if (check.kind === "not_possible") return { problem: check.reason };
  return {
    settings: { presentation: { kind: "choice", value: "grid" }, features },
  };
};
