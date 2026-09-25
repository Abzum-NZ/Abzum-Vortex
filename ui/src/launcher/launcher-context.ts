import { builderKeySchema } from "@vortex/contracts";
import { createDeclaredSettingsReader } from "../controls/control-context";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { getAccessibleName } from "../display/display-state-container";
import type { DisplayDataState, DisplayEventHandlers, ListPayload } from "../display/projected-data";
import type { PlatformBlockRenderProps } from "../registry";

const EMPTY_STATE: DisplayDataState<never> = Object.freeze({ status: "empty" });

const fail = (message: string, location: DefinitionRenderErrorLocation): never => {
  throw new DefinitionRenderError("INVALID_COMPOSITION", message, location);
};

/**
 * The props a launcher or tile block's renderer receives: the base props every block has, plus the
 * one closed `list` payload and its semantic callbacks its own registration validated fail-closed.
 */
export type LauncherRenderProps = PlatformBlockRenderProps &
  Readonly<{ data?: DisplayDataState<ListPayload>; events?: DisplayEventHandlers }>;

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
  values: ListPayload | undefined;
  /** State passed to the state container; a ready-but-empty list becomes the empty state. */
  state: DisplayDataState<ListPayload>;
  /** Declared callbacks; always absent while the placement's use is unavailable. */
  events: DisplayEventHandlers | undefined;
}>;

/**
 * Resolves one launcher or tile block's props. It never requests data: an absent projection renders
 * the empty state, and any value its own registration does not accept was already refused there.
 */
export function resolveLauncherListContext(
  props: LauncherRenderProps,
): LauncherListContext {
  const { metadata, placementId, data, availability } = props;
  const location: DefinitionRenderErrorLocation = {
    placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };
  const values = data?.status === "ready" ? data.values : undefined;

  const title = getAccessibleName(props.settings, metadata);
  return {
    location,
    title,
    accessibleName: title ?? metadata.name,
    values,
    state:
      data === undefined || (values !== undefined && values.rows.length === 0)
        ? EMPTY_STATE
        : data,
    events: availability === "available" ? props.events : undefined,
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
  const { read, text, boolean } = createDeclaredSettingsReader(props, location);

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
    boolean,
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
