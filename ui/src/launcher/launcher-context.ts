import { builderKeySchema, type BlockPropertyValueV2Contract } from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { getAccessibleName } from "../display/display-state-container";
import type {
  DisplayEventHandlers,
  ProjectedDisplayData,
  ProjectedDisplayValues,
} from "../display/projected-data";
import type { PlatformBlockRenderProps } from "../registry";

const EMPTY_STATE: ProjectedDisplayData = Object.freeze({ status: "empty" });

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

/**
 * Resolved context shared by the launcher and tile blocks. Each is a read-only display surface: it
 * renders a closed projected `list` of rows and never fetches data.
 */
export type LauncherListContext = Readonly<{
  location: DefinitionRenderErrorLocation;
  /** Authored accessible name, read only through the declared metadata path. */
  title: string | undefined;
  /** Authored name, or the block's palette name when the optional name is absent. */
  accessibleName: string;
  /** Ready `list` values, or undefined for any other projected state. */
  values: Extract<ProjectedDisplayValues, { kind: "list" }> | undefined;
  /** State passed to the state container; a ready-but-empty list becomes the empty state. */
  state: ProjectedDisplayData;
  /** Declared callbacks; always absent while the placement's use is unavailable. */
  events: DisplayEventHandlers | undefined;
}>;

/**
 * Resolves one launcher or tile block's props. It fails closed on any control projection or on ready
 * values of another kind, and never requests data: an absent projection renders the empty state.
 */
export function resolveLauncherListContext(
  props: PlatformBlockRenderProps,
): LauncherListContext {
  const { metadata, placementId, projectedData, availability } = props;
  const location: DefinitionRenderErrorLocation = {
    placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };
  if (props.controlData !== undefined || props.controlEvents !== undefined)
    fail(`Launcher block '${metadata.key}' does not accept control data or control events`, location);

  let values: Extract<ProjectedDisplayValues, { kind: "list" }> | undefined;
  if (projectedData?.status === "ready") {
    const ready = projectedData.values;
    values =
      ready.kind === "list"
        ? ready
        : fail(`Block '${metadata.key}' expected 'list' projected values, got '${ready.kind}'`, location);
  }

  const title = getAccessibleName(props.settings, metadata);
  return {
    location,
    title,
    accessibleName: title ?? metadata.name,
    values,
    state:
      projectedData === undefined || (values !== undefined && values.rows.length === 0)
        ? EMPTY_STATE
        : projectedData,
    events: availability === "available" ? props.displayEvents : undefined,
  };
}

/** Typed, fail-closed reads of a launcher placement's settings against its declared properties. */
export type LauncherSettings = Readonly<{
  text: (key: string) => string | undefined;
  boolean: (key: string) => boolean;
  /** A declared choice value restricted to the supplied option keys, or the fallback. */
  choice: <Option extends string>(
    key: string,
    options: readonly Option[],
    fallback: Option,
  ) => Option;
  /** A declared projected-cell key validated as a builder key, or undefined when absent. */
  optionalCellKey: (key: string) => string | undefined;
  /** A declared projected-cell key validated as a builder key, or the fallback when absent. */
  cellKey: (key: string, fallback: string) => string;
}>;

/**
 * Reads only settings the release declares; a value of the wrong kind or an authored value outside
 * the declared choice set fails closed rather than being coerced.
 */
export function readLauncherSettings(
  props: PlatformBlockRenderProps,
  location: DefinitionRenderErrorLocation,
): LauncherSettings {
  const { settings, metadata } = props;
  const read = (
    key: string,
    kind: BlockPropertyValueV2Contract["kind"],
  ): BlockPropertyValueV2Contract | undefined => {
    const property = metadata.properties.find((candidate) => candidate.key === key);
    if (property === undefined || property.kind !== kind)
      fail(`Block '${metadata.key}' declares no ${kind} property '${key}'`, location);
    const value = Object.hasOwn(settings, key) ? settings[key] : undefined;
    if (value !== undefined && value.kind !== kind)
      fail(`Setting '${key}' must be a ${kind} value`, { ...location, propertyPath: [key] });
    return value;
  };

  const text = (key: string): string | undefined => {
    const value = read(key, "text");
    return value?.kind === "text" && value.value.trim().length > 0
      ? value.value.trim()
      : undefined;
  };

  const optionalCellKey = (key: string): string | undefined => {
    const authored = text(key);
    if (authored === undefined) return undefined;
    const parsed = builderKeySchema.safeParse(authored);
    return parsed.success
      ? parsed.data
      : fail(`Setting '${key}' must be lowercase words separated by underscores`, {
          ...location,
          propertyPath: [key],
        });
  };

  return {
    text,
    boolean: (key) => {
      const value = read(key, "boolean");
      return value?.kind === "boolean" ? value.value : false;
    },
    choice: <Option extends string>(
      key: string,
      options: readonly Option[],
      fallback: Option,
    ): Option => {
      const value = read(key, "choice");
      if (value?.kind !== "choice") return fallback;
      if (!options.includes(value.value as Option))
        fail(`Setting '${key}' is not a declared choice`, { ...location, propertyPath: [key] });
      return value.value as Option;
    },
    optionalCellKey,
    cellKey: (key, fallback) => optionalCellKey(key) ?? fallback,
  };
}
