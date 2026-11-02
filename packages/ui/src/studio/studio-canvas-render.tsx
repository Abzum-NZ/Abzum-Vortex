"use client";

import { Item, ItemContent, ItemDescription, ItemTitle } from "../components/item";
import { Component, type ReactElement, type ReactNode } from "react";
import { placementWrapperGeometry } from "../puck-config";
import type { ComponentConfig, Config, Field, PuckContext } from "@puckeditor/core";
import {
  canonicalResponsivePlacement,
  findFieldInputBinding,
  holdsPermission,
  placementViewShown,
  plainSettingValue,
  releaseSettingDeclarations,
  typedSettingValue,
  type PlatformBlockRelease,
  type ResponsivePlacement,
} from "@vortex/platform/schema";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import { useStudioCanvasGridEvents } from "./studio-canvas-grid";
import { studioCanvasMetadata, type StudioCanvasRecords } from "./studio-canvas-metadata";
import { StudioCanvasRoot } from "./studio-canvas-root";

/**
 * The Studio canvas renders the stored items Puck holds with the one Puck config. A block's render
 * function takes a compiled item's props, so each canvas component reads its stored item for
 * drawing only: its plain settings over the plain settings its last compiled version holds
 * (defaults the author left out, settings the compiler derived, references it resolved), and its
 * stored block, layout and theme in their canonical spelling. A stored value is drawn only when it
 * is already a compiled value of its declaration, so an unresolved reference draws as compiled.
 * Everything Studio knows about the canvas (compiled settings, records, the previewed role, the
 * controls and the grid channel) arrives through Puck's `metadata`, as at runtime. Nothing here
 * is written to Puck's data.
 */

/** The controls whose chosen value the canvas can hold: their value is plain text. */
const previewControlKey = /\.(text|choice|date)_input$/;

/** What the canvas says in place of a current data block's records, or nothing when it has them. */
const recordsNote = (records: StudioCanvasRecords, id: string): string | undefined => {
  if (records.state === "loading") return "Reading records…";
  if (records.state === "refused")
    return "Showing records here needs permission to preview this application.";
  if (records.state === "not_runnable")
    return `Records show here once the draft can run. ${records.sentence ?? ""}`.trim();
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

const releaseOf = (
  registry: PlatformComponentRegistry,
  props: Readonly<Record<string, unknown>>,
) => {
  const block = ((props.vortex ?? {}) as StoredVortex).block;
  return typeof block?.block_id === "string" && typeof block.release_version === "string"
    ? registry.get(block.block_id, block.release_version)?.metadata
    : undefined;
};

type DragRef = ((element: Element | null) => void) | null | undefined;

const dragRefOf = (props: Readonly<Record<string, unknown>>): DragRef =>
  (props.puck as { dragRef?: DragRef } | undefined)?.dragRef;

/**
 * The one box every placeholder of a canvas block draws in: the placement's own wrapper geometry
 * (so a placeholder in a grid takes its declared cell) with Puck's drag reference on it.
 */
function CanvasPlaceholder({
  dragRef,
  props,
  children,
  ...data
}: Readonly<{
  dragRef: DragRef;
  props: Readonly<Record<string, unknown>>;
  children: ReactNode;
}> &
  Readonly<Record<`data-${string}`, string>>): ReactElement {
  const vortex = props.vortex as StoredVortex | undefined;
  const breakpoint =
    (props.puck as { metadata?: { breakpoint?: "desktop" | "tablet" | "phone" } } | undefined)
      ?.metadata?.breakpoint ?? "desktop";
  const responsive =
    vortex?.responsive === undefined
      ? undefined
      : (canonicalResponsivePlacement(vortex.responsive) as ResponsivePlacement);
  const geometry = placementWrapperGeometry(responsive, breakpoint);
  return (
    <div
      ref={dragRef ?? undefined}
      data-vortex-layout-wrapper=""
      data-vortex-placement-id={typeof props.id === "string" ? props.id : ""}
      {...(geometry.gridChild ? { "data-vortex-grid-child": "" } : {})}
      {...data}
      className={geometry.className}
      style={geometry.style}
    >
      {children}
    </div>
  );
}

/**
 * One canvas block that cannot be drawn says so in its own place, with the reason, while the rest of
 * the page and the outline stay usable; the cause goes to the console. It draws again when the
 * block's settings change.
 */
class CanvasBlockBoundary extends Component<
  Readonly<{ settings: unknown; props: Readonly<Record<string, unknown>>; children: ReactNode }>,
  Readonly<{ message: string | null }>
> {
  override state: Readonly<{ message: string | null }> = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : "" };
  }

  override componentDidCatch(error: unknown) {
    console.error("[studio] a canvas block could not be shown", error);
  }

  override componentDidUpdate(previous: Readonly<{ settings: unknown }>) {
    if (previous.settings !== this.props.settings && this.state.message !== null)
      this.setState({ message: null });
  }

  override render() {
    if (this.state.message === null) return this.props.children;
    return (
      <CanvasPlaceholder dragRef={dragRefOf(this.props.props)} props={this.props.props}>
        <Item variant="outline" size="sm" role="alert" className="border-destructive">
          <ItemContent>
            <ItemTitle>This block can't be shown</ItemTitle>
            <ItemDescription>{this.state.message}</ItemDescription>
          </ItemContent>
        </Item>
      </CanvasPlaceholder>
    );
  }
}

function CanvasBlock({
  component,
  registry,
  props,
}: Readonly<{
  component: ComponentConfig<Record<string, unknown>>;
  registry: PlatformComponentRegistry;
  props: Record<string, unknown>;
}>): ReactElement {
  const {
    compiled,
    records,
    viewer,
    controls: publishControl,
    grid,
  } = studioCanvasMetadata(props.puck as PuckContext);
  const id = typeof props.id === "string" ? props.id : "";
  const dragRef = dragRefOf(props);
  const release = releaseOf(registry, props);
  // One rule for "this block has records": the records read for it (a query or a record detail),
  // whatever its palette group. Launchers and link tiles are given theirs like a grid.
  const readsRecords = Object.hasOwn(records.saved, id) || Object.hasOwn(records.current, id);
  const current = Object.hasOwn(compiled, id) && records.saved[id] === records.current[id];
  const gridEvents = useStudioCanvasGridEvents(
    grid,
    props,
    current ? compiled[id] : undefined,
    release,
  );
  // A block just dropped from the palette is shown as a placeholder until Studio adds it.
  if (props.vortex === undefined)
    return (
      <CanvasPlaceholder dragRef={dragRef} props={props}>
        <Item variant="outline" size="sm" className="border-dashed">
          <ItemContent>
            <ItemDescription>Adding the block…</ItemDescription>
          </ItemContent>
        </Item>
      </CanvasPlaceholder>
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
      <CanvasPlaceholder dragRef={dragRef} props={props}>
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
      </CanvasPlaceholder>
    );
  const render = component.render as (props: Record<string, unknown>) => ReactElement;
  const refusal = records.refusal;
  if (
    refusal !== undefined &&
    (refusal.blockAlias === id || (refusal.blockAlias === undefined && readsRecords))
  )
    return (
      <CanvasPlaceholder dragRef={dragRef} props={props}>
        <Item
          variant="outline"
          role="alert"
          className="border-destructive"
          data-vortex-canvas-refusal={id}
        >
          <ItemContent>
            <ItemTitle>
              {refusal.sentence ?? records.sentence ?? "This block cannot run yet."}
            </ItemTitle>
            {refusal.guidance === undefined ? null : (
              <ItemDescription>{refusal.guidance}</ItemDescription>
            )}
          </ItemContent>
        </Item>
      </CanvasPlaceholder>
    );
  if (records.state === "not_runnable" && release !== undefined && readsRecords)
    return (
      <CanvasPlaceholder dragRef={dragRef} props={props}>
        <Item variant="outline" data-vortex-canvas-records-note={id}>
          <ItemContent>
            <ItemTitle>{release.name}</ItemTitle>
            <ItemDescription>Records show here once the draft can run.</ItemDescription>
          </ItemContent>
        </Item>
      </CanvasPlaceholder>
    );
  // A block whose drawing needs what the compiler derives (an automatic field input's control, a
  // data block's resolved fields) is drawn only from a compile of exactly this block. Until then
  // it shows that a save draws it; it is never drawn from settings the compiler has not seen.
  if (
    release !== undefined &&
    !current &&
    (findFieldInputBinding(release.properties) !== undefined || readsRecords)
  )
    return (
      <CanvasPlaceholder dragRef={dragRef} props={props}>
        <Item variant="outline" className="border-dashed" data-vortex-canvas-pending={id}>
          <ItemContent>
            <ItemTitle>{release.name}</ItemTitle>
            <ItemDescription>
              {records.updating ? "Updating the canvas…" : "Save to show this block."}
            </ItemDescription>
          </ItemContent>
        </Item>
      </CanvasPlaceholder>
    );
  // Data blocks use this revision's compiled settings even before their records arrive. Authored
  // groups can omit nested catalogue defaults and must never replace the compiled contract.
  const drawn = renderProps(
    props,
    release,
    Object.hasOwn(compiled, id) ? compiled[id] : undefined,
    current && release !== undefined && readsRecords,
  );
  // A control that publishes a page parameter reports its chosen value, so the blocks bound to it
  // are read again for that value, exactly as the running page reads them for its address.
  if (
    release !== undefined &&
    previewControlKey.test(release.key) &&
    release.supportedEvents.includes("field_changed") &&
    typeof drawn.publishes_parameter === "string" &&
    drawn.publishes_parameter !== ""
  ) {
    const puck = (props.puck ?? {}) as { metadata?: Record<string, unknown> };
    const fieldChanged = (event: { event: string; value?: unknown }) => {
      if (event.event === "field_changed")
        publishControl(
          id,
          event.value === null || event.value === undefined ? "" : String(event.value),
        );
    };
    return render({
      ...drawn,
      puck: {
        ...puck,
        metadata: {
          ...puck.metadata,
          runtimeInputs: { [id]: { events: { field_changed: fieldChanged } } },
        },
      },
    });
  }
  // A block of the page's own record (a Record detail) draws that record as its saved version read it.
  if (release === undefined || !readsRecords) return render(drawn);
  // A data block draws the records its saved version reads, and says so when it has none to show.
  const note = recordsNote(records, id);
  const puck = (props.puck ?? {}) as { metadata?: Record<string, unknown> };
  // No wrapper around the block itself: its own layout wrapper stays the child of its slot.
  return note === undefined ? (
    render({
      ...drawn,
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
    <CanvasPlaceholder dragRef={dragRef} props={props}>
      <p className="text-xs text-muted-foreground" data-vortex-canvas-records-note={id}>
        {note}
      </p>
    </CanvasPlaceholder>
  );
}

const canvasConfigs = new WeakMap<Config, Config>();

/** The input blocks that each register one form field: an input naming its field. */
const formFieldRendererKeys = (registry: PlatformComponentRegistry): ReadonlySet<string> =>
  new Set(
    registry
      .getReleases()
      .filter(
        (release) =>
          release.paletteGroup === "input" &&
          release.properties.some(
            (property) => property.key === "name" || property.key === "field",
          ),
      )
      .map((release) => release.rendererKey),
  );

/**
 * The canvas config: the one config's components and root, each component drawing its stored
 * item as above. The fields stay exactly as the one config declares them (each slot with its
 * `allow` list, every other prop an opaque object), because Puck finds slots through them and Studio edits
 * settings in its inspector. No defaults are merged: a block dropped from the palette is added by
 * Studio's add command, never by Puck.
 */
export const studioCanvasConfig = (
  config: Config,
  registry: PlatformComponentRegistry,
  fieldInputControlReleases: FieldInputControlReleaseMap,
): Config => {
  let canvas = canvasConfigs.get(config);
  if (canvas !== undefined) return canvas;
  const fieldInputs = formFieldRendererKeys(registry);
  const components = Object.fromEntries(
    Object.entries(
      config.components as Record<string, ComponentConfig<Record<string, unknown>>>,
    ).map(([type, component]) => [
      type,
      {
        label: component.label,
        // Every canvas component is measured and dragged by its own root element.
        inline: true,
        fields: (component.fields ?? {}) as Record<string, Field>,
        ...(component.resolveFields === undefined
          ? {}
          : {
              resolveFields: (data: { props: Record<string, unknown> }, params: unknown) => {
                const props = renderProps(data.props, releaseOf(registry, data.props), undefined);
                const resolve = component.resolveFields as unknown as (
                  data: { props: Record<string, unknown> },
                  params: unknown,
                ) => Record<string, Field>;
                return resolve({ ...data, props }, params);
              },
            }),
        render: (props: Record<string, unknown>) => (
          <CanvasBlockBoundary settings={props.vortex} props={props}>
            <CanvasBlock component={component} registry={registry} props={props} />
          </CanvasBlockBoundary>
        ),
        // A second input for a field the form already shows would be refused when the form
        // draws, so a field input is never duplicated; add another field from the palette.
        ...(fieldInputs.has(type) ? { permissions: { duplicate: false } } : {}),
      },
    ]),
  );
  canvas = {
    ...config,
    components,
    // The application frame is the canvas root: it draws the theme, appearance and shell around the page.
    root: {
      ...config.root,
      render: (props: Parameters<typeof StudioCanvasRoot>[0]) => (
        <StudioCanvasRoot
          {...props}
          registry={registry}
          fieldInputControlReleases={fieldInputControlReleases}
        />
      ),
    },
  } as unknown as Config;
  canvasConfigs.set(config, canvas);
  return canvas;
};
