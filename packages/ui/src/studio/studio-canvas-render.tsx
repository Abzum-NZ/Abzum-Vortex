"use client";

import { Item, ItemContent, ItemDescription, ItemTitle } from "../components/item";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { ComponentConfig, Config, Field } from "@puckeditor/core";
import {
  canonicalResponsivePlacement,
  findFieldInputBinding,
  holdsPermission,
  placementViewShown,
  plainSettingValue,
  releaseSettingDeclarations,
  typedSettingValue,
  type NavigationPermissionDecisions,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import type { PlatformComponentRegistry } from "../registry";
import { studioReleaseReadsQuery } from "./contextual-palette";
import { useStudioCanvasGridEvents } from "./studio-canvas-grid";

/**
 * The Studio canvas renders the stored items Puck holds with the one Puck config. A block's render
 * function takes a compiled item's props, so each canvas component reads its stored item for
 * drawing only: its plain settings over the plain settings its last compiled version holds
 * (defaults the author left out, settings the compiler derived, references it resolved), and its
 * stored block, layout and theme in their canonical spelling. A stored value is drawn only when it
 * is already a compiled value of its declaration, so an unresolved reference draws as compiled.
 * Nothing here is written to Puck's data.
 */

type CompiledSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const CompiledSettingsContext = createContext<CompiledSettings>({});

/** Supplies, by block name, the settings each block's last compiled version holds. */
export function StudioCanvasCompiledSettings({
  settings,
  children,
}: Readonly<{ settings: CompiledSettings; children: ReactNode }>): ReactElement {
  return (
    <CompiledSettingsContext.Provider value={settings}>{children}</CompiledSettingsContext.Provider>
  );
}

/**
 * The records the canvas's data blocks show: read from the builder's preview of one saved draft
 * revision with their preview access, by block name, with what each block looked like in that
 * saved revision. A block is given its records only while it is still exactly as it was saved; a
 * block edited since shows that it needs a save, never the records of its old settings.
 * `refused` means the builder may not preview this application, so no records are read.
 */
export type StudioCanvasRecords = Readonly<{
  state: "loading" | "ready" | "refused" | "unavailable";
  /** The records of each data block of the saved revision, by block name. */
  records: Readonly<Record<string, unknown>>;
  /** Each block's release, settings and query in the saved revision the records were read for. */
  saved: ReadonlyMap<string, string>;
  /** Each block's release, settings and query now, in the same spelling. */
  current: ReadonlyMap<string, string>;
  /** A newer saved revision is being compiled; its records follow. */
  updating: boolean;
  /** On a page of one record, the record its blocks show: absent elsewhere. */
  sample?: StudioCanvasSample;
}>;

/** The record a detail page's blocks show on the canvas: the first of its type in the preview, untitled when there is none. */
export type StudioCanvasSample = Readonly<{ recordTypeName: string; title?: string }>;

const NO_RECORDS: StudioCanvasRecords = Object.freeze({
  state: "loading",
  records: {},
  saved: new Map<string, string>(),
  current: new Map<string, string>(),
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

/**
 * Studio's "who can see this" preview: the role whose view the canvas shows and the permissions it
 * holds. A block is judged with the page projection's own view rule, so the canvas hides exactly the
 * blocks the running application drops for that role; `null` is the design view, where all show.
 */
export type StudioCanvasViewer = Readonly<{
  roleName: string;
  decisions: NavigationPermissionDecisions;
}>;
const CanvasViewerContext = createContext<StudioCanvasViewer | null>(null);

/** Supplies the role the canvas previews, or `null` for the design view. */
export function StudioCanvasViewerProvider({
  viewer,
  children,
}: Readonly<{ viewer: StudioCanvasViewer | null; children: ReactNode }>): ReactElement {
  return <CanvasViewerContext.Provider value={viewer}>{children}</CanvasViewerContext.Provider>;
}

/** What the canvas says in place of a current data block's records, or nothing when it has them. */
const recordsNote = (records: StudioCanvasRecords, id: string): string | undefined => {
  if (records.state === "loading") return "Reading records…";
  if (records.state === "refused")
    return "Showing records here needs permission to preview this application.";
  if (records.state === "unavailable") return "Records could not be read just now.";
  if (Object.hasOwn(records.records, id)) return undefined;
  return records.sample !== undefined && records.sample.title === undefined
    ? `The preview has no ${records.sample.recordTypeName.toLowerCase()} you can read yet. Add one in the preview to show this block with it.`
    : "This block shows its records in the running application.";
};

type StoredBlock = Readonly<{ block_id?: unknown; release_version?: unknown }>;
type StoredVortex = Readonly<{
  block?: StoredBlock;
  responsive?: Readonly<Record<string, unknown>>;
}>;

/** The props one block's render function takes, read from a stored item's props. */
const renderProps = (
  props: Readonly<Record<string, unknown>>,
  release: PlatformBlockRelease | undefined,
  compiled: Readonly<Record<string, unknown>> | undefined,
  /** The stored item is exactly the one `compiled` was compiled from, so its compiled settings stand alone. */
  exact = false,
): Record<string, unknown> => {
  const vortex = (props.vortex ?? {}) as StoredVortex;
  const result: Record<string, unknown> = { ...props };
  if (release !== undefined) {
    const authored: Record<string, unknown> = {};
    for (const property of releaseSettingDeclarations(release)) {
      const value = props[property.key];
      if (value !== undefined && typedSettingValue(value, property) !== undefined)
        authored[property.key] = value;
      delete result[property.key];
    }
    // A block added since the last compile draws with its release's defaults, as publication writes them.
    Object.assign(
      result,
      compiled ?? catalogueDefaults(release),
      exact && compiled !== undefined ? {} : authored,
    );
  }
  result.vortex = {
    block: { blockId: vortex.block?.block_id, releaseVersion: vortex.block?.release_version },
    responsive:
      vortex.responsive === undefined ? undefined : canonicalResponsivePlacement(vortex.responsive),
  };
  return result;
};

/** The release's declared defaults, as the plain values a compiled item carries. */
const catalogueDefaults = (release: PlatformBlockRelease): Record<string, unknown> =>
  Object.fromEntries(
    release.properties.flatMap((property) =>
      property.defaultValue === undefined
        ? []
        : [[property.key, plainSettingValue(property.defaultValue)]],
    ),
  );

/**
 * The slot fields only, without Puck's `allow` lists: a block dropped or moved into any slot
 * reaches Studio, whose stored composition check admits it or refuses it with its place and rule.
 */
const slotFields = (fields: Record<string, Field> | undefined): Record<string, Field> =>
  Object.fromEntries(
    Object.entries(fields ?? {}).flatMap(([key, field]) => {
      if (field.type !== "slot") return [];
      const slot: Record<string, unknown> = { ...field };
      delete slot.allow;
      delete slot.disallow;
      return [[key, slot as unknown as Field]];
    }),
  );

const releaseOf = (
  registry: PlatformComponentRegistry,
  props: Readonly<Record<string, unknown>>,
) => {
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
  const viewer = useContext(CanvasViewerContext);
  const id = typeof props.id === "string" ? props.id : "";
  const release = releaseOf(registry, props);
  const gridEvents = useStudioCanvasGridEvents(props, compiled[id], release);
  // A block just dropped from the palette is shown as a placeholder until Studio adds it.
  if (props.vortex === undefined)
    return (
      <Item variant="outline" size="sm" className="border-dashed">
        <ItemContent>
          <ItemDescription>Adding the block…</ItemDescription>
        </ItemContent>
      </Item>
    );
  const viewKey = (props.vortex as { view_permission?: unknown }).view_permission;
  if (
    viewer !== null &&
    !placementViewShown(
      viewKey,
      typeof viewKey === "string" && holdsPermission(viewer.decisions, viewKey),
    )
  )
    return (
      <Item
        variant="outline"
        size="sm"
        className="border-dashed opacity-60"
        data-vortex-canvas-hidden={id}
      >
        <ItemContent>
          <ItemDescription>Hidden from {viewer.roleName}</ItemDescription>
        </ItemContent>
      </Item>
    );
  const render = component.render as (props: Record<string, unknown>) => ReactElement;
  // A block whose drawing needs what the compiler derives (an automatic field input's control, a
  // data block's resolved fields) is drawn only from a compile of exactly this block. Until then
  // it shows that a save draws it; it is never drawn from settings the compiler has not seen.
  const current = Object.hasOwn(compiled, id) && records.saved.get(id) === records.current.get(id);
  if (
    release !== undefined &&
    !current &&
    (findFieldInputBinding(release.properties) !== undefined || studioReleaseReadsQuery(release))
  )
    return (
      <Item variant="outline" className="border-dashed" data-vortex-canvas-pending={id}>
        <ItemContent>
          <ItemTitle>{release.name}</ItemTitle>
          <ItemDescription>
            {records.updating ? "Updating the canvas…" : "Save to show this block."}
          </ItemDescription>
        </ItemContent>
      </Item>
    );
  const drawn = renderProps(props, release, Object.hasOwn(compiled, id) ? compiled[id] : undefined);
  // A block of the page's own record (a Record detail) draws that record as its saved version read it.
  if (
    release === undefined ||
    !(studioReleaseReadsQuery(release) || (release.paletteGroup === "record" && current))
  )
    return render(drawn);
  // A data block draws the records its saved version reads, and says so when it has none to show.
  const note = recordsNote(records, id);
  const puck = (props.puck ?? {}) as { metadata?: Record<string, unknown> };
  // No wrapper around the block itself: its own layout wrapper stays the child of its slot.
  return note === undefined ? (
    render({
      ...renderProps(props, release, Object.hasOwn(compiled, id) ? compiled[id] : undefined, true),
      puck: {
        ...puck,
        metadata: {
          ...puck.metadata,
          runtimeInputs: {
            [id]: {
              data: records.records[id],
              ...(gridEvents === undefined ? {} : { events: gridEvents }),
            },
          },
        },
      },
    })
  ) : (
    <>
      <p className="text-xs text-muted-foreground" data-vortex-canvas-records-note={id}>
        {note}
      </p>
      {render(drawn)}
    </>
  );
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
    Object.entries(
      config.components as Record<string, ComponentConfig<Record<string, unknown>>>,
    ).map(([type, component]) => [
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
    ]),
  );
  canvas = { ...config, components } as unknown as Config;
  canvasConfigs.set(config, canvas);
  return canvas;
};
