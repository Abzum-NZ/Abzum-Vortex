"use client";

import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { ComponentConfig, Config, Field } from "@puckeditor/core";
import {
  canonicalResponsivePlacement,
  canonicalThemeTokenValue,
  typedSourceSettings,
  type BlockPropertyValueContract,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import type { PlatformComponentRegistry } from "../registry";
import { studioReleaseReadsQuery } from "./contextual-palette";

/**
 * The Studio canvas renders the stored items Puck holds with the one Puck config. A block's render
 * function takes a compiled item's props, so each canvas component reads its stored item for
 * drawing only: its typed settings over the settings its last compiled version holds (defaults the
 * author left out, references the compiler resolved), and its stored block, layout and theme in
 * their canonical spelling. Nothing here is written to Puck's data.
 */

type CompiledSettings = Readonly<Record<string, Readonly<Record<string, BlockPropertyValueContract>>>>;

const CompiledSettingsContext = createContext<CompiledSettings>({});

/** Supplies, by block name, the settings each block's last compiled version holds. */
export function StudioCanvasCompiledSettings({
  settings,
  children,
}: Readonly<{ settings: CompiledSettings; children: ReactNode }>): ReactElement {
  return <CompiledSettingsContext.Provider value={settings}>{children}</CompiledSettingsContext.Provider>;
}

/**
 * The records the canvas's data blocks show: read for one saved draft revision with the builder's
 * own access, by block name, with what each block looked like in that saved revision. A block is
 * given its records only while it is still exactly as it was saved; a block edited since shows
 * that it needs a save, never the records of its old settings.
 */
export type StudioCanvasRecords = Readonly<{
  state: "loading" | "ready" | "not_installed" | "unavailable";
  /** Blocks whose query the installed application does not have yet. */
  notInstalled: readonly string[];
  /** The records of each data block of the saved revision, by block name. */
  records: Readonly<Record<string, unknown>>;
  /** Each block's release, settings and query in the saved revision the records were read for. */
  saved: ReadonlyMap<string, string>;
  /** Each block's release, settings and query now, in the same spelling. */
  current: ReadonlyMap<string, string>;
  /** A newer saved revision is being compiled; its records follow. */
  updating: boolean;
}>;

const NO_RECORDS: StudioCanvasRecords = Object.freeze({
  state: "loading", records: {}, notInstalled: [], saved: new Map<string, string>(), current: new Map<string, string>(),
  updating: false,
});
const CanvasRecordsContext = createContext<StudioCanvasRecords>(NO_RECORDS);

/** Supplies the records of the canvas's data blocks. */
export function StudioCanvasRecordsProvider({
  records,
  children,
}: Readonly<{ records: StudioCanvasRecords; children: ReactNode }>): ReactElement {
  return <CanvasRecordsContext.Provider value={records}>{children}</CanvasRecordsContext.Provider>;
}

/** What the canvas says in place of a data block's records, or nothing when it has them. */
const recordsNote = (records: StudioCanvasRecords, id: string): string | undefined => {
  const saved = records.saved.get(id);
  if (saved === undefined || saved !== records.current.get(id))
    return records.updating ? "Updating the canvas…" : "Save to show this block's records.";
  if (records.state === "loading") return "Reading records…";
  if (records.state === "not_installed") return "Install this application to show its records here.";
  if (records.state === "unavailable") return "Records could not be read just now.";
  if (records.notInstalled.includes(id)) return "This query is not installed yet. Publish and upgrade to show its records here.";
  return Object.hasOwn(records.records, id) ? undefined : "This block shows its records in the running application.";
};

type StoredBlock = Readonly<{ block_id?: unknown; release_version?: unknown }>;
type StoredVortex = Readonly<{
  block?: StoredBlock;
  responsive?: Readonly<Record<string, unknown>>;
  theme_overrides?: Readonly<Record<string, Record<string, unknown>>>;
}>;

/** The props one block's render function takes, read from a stored item's props. */
const renderProps = (
  props: Readonly<Record<string, unknown>>,
  release: PlatformBlockRelease | undefined,
  compiled: Readonly<Record<string, BlockPropertyValueContract>> | undefined,
  /** The stored item is exactly the one `compiled` was compiled from, so its compiled settings stand alone. */
  exact = false,
): Record<string, unknown> => {
  const vortex = (props.vortex ?? {}) as StoredVortex;
  const result: Record<string, unknown> = { ...props };
  if (release !== undefined) {
    const authored: Record<string, unknown> = {};
    for (const property of release.properties) {
      if (props[property.key] !== undefined) authored[property.key] = props[property.key];
      delete result[property.key];
    }
    // A block added since the last compile draws with its release's defaults, as publication writes them.
    Object.assign(result, compiled ?? catalogueDefaults(release),
      exact && compiled !== undefined ? {} : typedSourceSettings(authored, release.properties).settings);
  }
  result.vortex = {
    block: { blockId: vortex.block?.block_id, releaseVersion: vortex.block?.release_version },
    themeOverrides: Object.fromEntries(
      Object.entries(vortex.theme_overrides ?? {}).map(([key, value]) => [key, canonicalThemeTokenValue(value)]),
    ),
    responsive: vortex.responsive === undefined ? undefined : canonicalResponsivePlacement(vortex.responsive),
  };
  return result;
};

const catalogueDefaults = (release: PlatformBlockRelease): Record<string, BlockPropertyValueContract> =>
  Object.fromEntries(release.properties.flatMap((property) =>
    property.defaultValue === undefined ? [] : [[property.key, property.defaultValue]]));

/**
 * The slot fields only, without Puck's `allow` lists: a block dropped or moved into any slot
 * reaches Studio, whose stored composition check admits it or refuses it with its place and rule.
 */
const slotFields = (fields: Record<string, Field> | undefined): Record<string, Field> =>
  Object.fromEntries(Object.entries(fields ?? {}).flatMap(([key, field]) => {
    if (field.type !== "slot") return [];
    const slot: Record<string, unknown> = { ...field };
    delete slot.allow;
    delete slot.disallow;
    return [[key, slot as unknown as Field]];
  }));

const releaseOf = (registry: PlatformComponentRegistry, props: Readonly<Record<string, unknown>>) => {
  const block = ((props.vortex ?? {}) as StoredVortex).block;
  return typeof block?.block_id === "string" && typeof block.release_version === "string"
    ? registry.get(block.block_id, block.release_version)?.metadata
    : undefined;
};

function CanvasBlock({
  component,
  registry,
  props,
}: Readonly<{
  component: ComponentConfig<Record<string, unknown>>;
  registry: PlatformComponentRegistry;
  props: Record<string, unknown>;
}>): ReactElement {
  const compiled = useContext(CompiledSettingsContext);
  const records = useContext(CanvasRecordsContext);
  const id = typeof props.id === "string" ? props.id : "";
  // A block just dropped from the palette is shown as a placeholder until Studio adds it.
  if (props.vortex === undefined)
    return <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">Adding the block…</div>;
  const render = component.render as (props: Record<string, unknown>) => ReactElement;
  const release = releaseOf(registry, props);
  const drawn = renderProps(props, release, Object.hasOwn(compiled, id) ? compiled[id] : undefined);
  if (release === undefined || !studioReleaseReadsQuery(release)) return render(drawn);
  // A data block draws the records its saved version reads, and says so when it has none to show.
  const note = recordsNote(records, id);
  const puck = (props.puck ?? {}) as { metadata?: Record<string, unknown> };
  // No wrapper around the block itself: its own layout wrapper stays the child of its slot.
  return note === undefined
    ? render({ ...renderProps(props, release, Object.hasOwn(compiled, id) ? compiled[id] : undefined, true),
        puck: { ...puck, metadata: { ...puck.metadata, runtimeInputs: { [id]: { data: records.records[id] } } } } })
    : <>
        <p className="text-xs text-muted-foreground" data-vortex-canvas-records-note={id}>{note}</p>
        {render(drawn)}
      </>;
}

const canvasConfigs = new WeakMap<Config, Config>();

/**
 * The canvas config: the one config's components and root, each component drawing its stored
 * item as above. Only slot fields remain, because Puck finds slots through them and Studio edits
 * settings in its inspector. No defaults are merged: a block dropped from the palette is added by
 * Studio's add command, never by Puck.
 */
export const studioCanvasConfig = (config: Config, registry: PlatformComponentRegistry): Config => {
  let canvas = canvasConfigs.get(config);
  if (canvas !== undefined) return canvas;
  const components = Object.fromEntries(
    Object.entries(config.components as Record<string, ComponentConfig<Record<string, unknown>>>).map(
      ([type, component]) => [
        type,
        {
          label: component.label,
          fields: slotFields(component.fields as Record<string, Field> | undefined),
          ...(component.resolveFields === undefined
            ? {}
            : {
                resolveFields: (data: { props: Record<string, unknown> }, params: unknown) => {
                  const props = renderProps(data.props, releaseOf(registry, data.props), undefined);
                  const resolve = component.resolveFields as unknown as (
                    data: { props: Record<string, unknown> },
                    params: unknown,
                  ) => Record<string, Field>;
                  return slotFields(resolve({ ...data, props }, params));
                },
              }),
          render: (props: Record<string, unknown>) => (
            <CanvasBlock component={component} registry={registry} props={props} />
          ),
        },
      ],
    ),
  );
  canvas = { ...config, components } as unknown as Config;
  canvasConfigs.set(config, canvas);
  return canvas;
};
