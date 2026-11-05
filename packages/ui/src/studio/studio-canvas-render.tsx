"use client";

import { Item, ItemContent, ItemDescription, ItemTitle } from "../components/item";
import { Component, useMemo, type ReactElement, type ReactNode } from "react";
import {
  placementWrapperGeometry,
  releasesByRendererKey,
  withRepeatingSlots,
} from "../puck-config";
import type { ComponentConfig, Config, Field, PuckContext } from "@puckeditor/core";
import {
  canonicalResponsivePlacement,
  findFieldInputBinding,
  holdsPermission,
  placementViewShown,
  plainSettingValue,
  releaseSettingDeclarations,
  typedSettingValue,
  type ImmutablePlatformBlockCatalogue,
  type PlatformBlockRelease,
  type ResponsivePlacement,
} from "@vortex/platform/schema";
import { studioPaletteChoices } from "./contextual-palette";
import { studioVortexField, withSettingFields } from "./studio-puck-settings";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import { useStudioCanvasGridEvents } from "./studio-canvas-grid";
import {
  studioCanvasMetadata,
  useStudioCanvasChannel,
  type StudioCanvasRecords,
} from "./studio-canvas-metadata";
import { StudioCanvasRoot } from "./studio-canvas-root";

/**
 * The Studio canvas renders the stored items Puck holds with the one Puck config. A block's render
 * function takes a compiled item's props, so each canvas component reads its stored item for
 * drawing only: its plain settings over the plain settings its last compiled version holds
 * (defaults the author left out, settings the compiler derived, references it resolved), and its
 * stored block, layout and theme in their canonical spelling. A stored value is drawn only when it
 * is already a compiled value of its declaration, so an unresolved reference draws as compiled.
 * Everything Studio knows about the canvas (compiled settings, records, the previewed role, the
 * controls and the grid channel) arrives through the canvas channel (React context): Puck walks its
 * `metadata` once per block, so nothing that grows with the page goes there. Nothing here is
 * written to Puck's data.
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

/** The catalogue release a placed block's props name. */
const placedRelease = (
  releases: ReadonlyMap<string, PlatformBlockRelease>,
  props: Readonly<Record<string, unknown>>,
): PlatformBlockRelease | undefined => {
  const block = ((props.vortex ?? {}) as StoredVortex).block;
  return typeof block?.block_id === "string" && typeof block.release_version === "string"
    ? releases.get(`${block.block_id}@${block.release_version}`)
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
  const { breakpoint } = studioCanvasMetadata(props.puck as PuckContext);
  if (breakpoint === undefined)
    throw new Error("STUDIO_CANVAS_BREAKPOINT_MISSING: the canvas metadata has no breakpoint");
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
 * the page and the outline stay usable (React reports the cause to the console once). It draws
 * again when what the block draws from changes: its stored settings or its compiled settings.
 */
class CanvasBlockBoundary extends Component<
  Readonly<{
    resetKeys: readonly unknown[];
    props: Readonly<Record<string, unknown>>;
    children: ReactNode;
  }>,
  Readonly<{ message: string | null }>
> {
  override state: Readonly<{ message: string | null }> = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : "" };
  }

  override componentDidUpdate(previous: Readonly<{ resetKeys: readonly unknown[] }>) {
    if (
      this.state.message !== null &&
      this.props.resetKeys.some((key, index) => key !== previous.resetKeys[index])
    )
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

/** One canvas block inside its boundary, which draws it again when its stored or compiled settings change. */
function CanvasBlockFrame({
  component,
  registry,
  props,
}: Readonly<{
  component: ComponentConfig<Record<string, unknown>>;
  registry: PlatformComponentRegistry;
  props: Record<string, unknown>;
}>): ReactElement {
  const { compiled } = useStudioCanvasChannel();
  const id = typeof props.id === "string" ? props.id : "";
  return (
    <CanvasBlockBoundary
      resetKeys={[props.vortex, Object.hasOwn(compiled, id) ? compiled[id] : undefined]}
      props={props}
    >
      <CanvasBlock component={component} registry={registry} props={props} />
    </CanvasBlockBoundary>
  );
}

/** What a layout block draws in a slot reserved for the page's content: its pages' blocks are not edited here. */
function PageContentPlaceholder({ label }: Readonly<{ label: string }>): ReactElement {
  return (
    <Item variant="outline" className="border-dashed" data-vortex-canvas-page-content={label}>
      <ItemContent>
        <ItemTitle>Page content</ItemTitle>
        <ItemDescription>{label}</ItemDescription>
      </ItemContent>
    </Item>
  );
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
    contentTargets,
    frame,
  } = useStudioCanvasChannel();
  const id = typeof props.id === "string" ? props.id : "";
  // The slots of this block that hold a page's content (a layout on the canvas), each with the
  // placeholder drawn in place of a slot Puck would let a block be dropped into.
  const reserved = Object.hasOwn(contentTargets, id) ? contentTargets[id] : undefined;
  // The menu a layout's navigation block draws is the application's, as in the page's frame: the
  // frame's own render gives it through the renderer's metadata, which the canvas's blocks lack.
  const navigation = frame?.layout === true ? frame.frame?.navigation : undefined;
  const pageId = frame?.layout === true ? frame.frame?.pageId : undefined;
  const menuMetadata = useMemo(
    () =>
      navigation === undefined
        ? undefined
        : { projectedNavigation: navigation, resolvePageHref: () => "#", currentPageId: pageId },
    [navigation, pageId],
  );
  const puckMetadata = (props.puck as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const blockMetadata = useMemo(
    () => (menuMetadata === undefined ? undefined : { ...puckMetadata, ...menuMetadata }),
    [puckMetadata, menuMetadata],
  );
  const slotNodes = useMemo(
    () =>
      reserved === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(reserved).map(([slot, label]) => [
              slot,
              <PageContentPlaceholder key={slot} label={label} />,
            ]),
          ),
    [reserved],
  );
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
  // The interim item of a block that is being set up: its settings are asked in the dialog first.
  if ((props.vortex as { interim?: unknown }).interim === true)
    return (
      <CanvasPlaceholder dragRef={dragRef} props={props}>
        <Item variant="outline" size="sm" className="border-dashed">
          <ItemContent>
            <ItemDescription>Setting up the block…</ItemDescription>
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
  if (slotNodes !== undefined) drawn.slotNodes = slotNodes;
  if (blockMetadata !== undefined)
    drawn.puck = { ...(props.puck as object), metadata: blockMetadata };
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

/**
 * By base config and catalogue, then by root slots: the canvas built once (`shell`, drawn from the
 * base config alone) and the latest config made from it with the repeating keys then held.
 */
const canvasConfigs = new WeakMap<
  Config,
  WeakMap<
    ImmutablePlatformBlockCatalogue,
    Map<string, Readonly<{ shell: Config; repeatingKey: string; config: Config }>>
  >
>();

/** The shell with a slot field for each repeating key the page holds, hidden like every slot. */
const withHeldRepeatingSlots = (
  registry: PlatformComponentRegistry,
  shell: Config,
  repeating: ReadonlyMap<string, readonly string[]>,
): Config => {
  const config = withRepeatingSlots(registry, shell, repeating);
  if (config === shell) return shell;
  const components = { ...config.components } as Record<string, ComponentConfig>;
  for (const rendererKey of repeating.keys()) {
    const component = components[rendererKey];
    if (component?.fields !== undefined)
      components[rendererKey] = {
        ...component,
        fields: Object.fromEntries(
          Object.entries(component.fields).map(([key, field]) => [
            key,
            field.type === "slot" ? { ...field, visible: false } : field,
          ]),
        ),
      };
  }
  return { ...config, components } as Config;
};

/**
 * The canvas config: the one config's components and root, each component drawing its stored
 * item as above. The fields stay exactly as the one config declares them (each slot with its
 * `allow` list, every other prop an opaque object), because Puck finds slots through them and Studio edits
 * settings in its inspector. A block dropped from the palette is added by Studio's add command,
 * never kept from Puck's insert. The interim item Puck holds until then carries only the block's
 * identity and plain placement, in the stored spelling a stored block has, so it draws as the block with its release
 * defaults (Puck merges `defaultProps` under every block it draws, so they hold nothing else: a
 * stored block's own `vortex` replaces them). A block Studio cannot create yet
 * (its palette choice names why) is not insertable, so Puck does not let it be dragged.
 */
export const studioCanvasConfig = (
  baseConfig: Config,
  registry: PlatformComponentRegistry,
  fieldInputControlReleases: FieldInputControlReleaseMap,
  catalogue: ImmutablePlatformBlockCatalogue,
  /** The page's root slots with their labels: one slot field of the root for each content slot of its shell. */
  slots: readonly (readonly [key: string, label: string])[],
  /** The keys of the repeating slots the page holds (a tab is `tab_<key>`), by renderer key. */
  repeating: ReadonlyMap<string, readonly string[]>,
): Config => {
  const slotsKey = JSON.stringify(slots);
  const repeatingKey = JSON.stringify([...repeating]);
  const bySlotsHeld = canvasConfigs.get(baseConfig)?.get(catalogue);
  const cached = bySlotsHeld?.get(slotsKey);
  if (cached !== undefined) {
    if (cached.repeatingKey === repeatingKey) return cached.config;
    // A change of the keys replaces only the static fields of the renderers that hold repeating
    // slots: every render function, field renderer and the root keep their identity, so nothing
    // remounts.
    const config = withHeldRepeatingSlots(registry, cached.shell, repeating);
    bySlotsHeld?.set(slotsKey, { shell: cached.shell, repeatingKey, config });
    return config;
  }
  const slotKeys = slots.map(([key]) => key);
  const releaseByKey = releasesByRendererKey(registry);
  const choices = studioPaletteChoices(catalogue, catalogue.releases);
  const notCreatable = new Set(
    choices
      .filter((choice) => choice.unavailable !== undefined)
      .map((choice) => choice.rendererKey),
  );
  // A block that asks for settings or a query when it is added cannot be drawn from defaults alone.
  const needsSetup = new Set(
    choices
      .filter((choice) => choice.setup.length > 0 || choice.needsQuery)
      .map((choice) => choice.rendererKey),
  );
  const releases = new Map(
    catalogue.releases.map((release) => [`${release.blockId}@${release.releaseVersion}`, release]),
  );
  const components = Object.fromEntries(
    Object.entries(
      baseConfig.components as Record<string, ComponentConfig<Record<string, unknown>>>,
    ).map(([type, component]) => [
      type,
      {
        label: component.label,
        defaultProps: {
          vortex: {
            block: {
              block_id: releaseByKey.get(type)?.blockId,
              release_version: releaseByKey.get(type)?.releaseVersion,
            },
            responsive: {
              desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
            },
            // Only the interim item carries this (a stored block's own `vortex` replaces it).
            ...(needsSetup.has(type) ? { interim: true } : {}),
          },
        },
        // Every canvas component is measured and dragged by its own root element.
        inline: true,
        ...withSettingFields(
          component,
          (props) => placedRelease(releases, props),
          component.resolveFields === undefined
            ? undefined
            : (data, params) => {
                const props = renderProps(data.props, releaseOf(registry, data.props), undefined);
                const resolve = component.resolveFields as unknown as (
                  data: { props: Record<string, unknown> },
                  params: unknown,
                ) => Record<string, Field>;
                return resolve({ ...data, props }, params);
              },
          // A block that holds tabs: Puck shows its static fields while a new config's fields resolve.
          releaseByKey.get(type)?.slots.some((slot) => slot.repeats !== undefined)
            ? releaseByKey.get(type)
            : undefined,
        ),
        render: (props: Record<string, unknown>) => (
          <CanvasBlockFrame component={component} registry={registry} props={props} />
        ),
        permissions: {
          ...(notCreatable.has(type) ? { insert: false } : {}),
        },
      },
    ]),
  );
  const canvas = {
    ...baseConfig,
    components,
    // The application frame is the canvas root: it draws the theme, appearance and shell around the
    // page. Puck's data holds only what the stored page holds, so the root has no props of its own
    // (no defaults, no settings) beside one slot per content slot of the page's shell.
    root: {
      fields: {
        ...Object.fromEntries(slots.map(([key, label]) => [key, { type: "slot", label }])),
        vortex: studioVortexField,
      },
      render: (props: Parameters<typeof StudioCanvasRoot>[0]) => (
        <StudioCanvasRoot
          {...props}
          slotKeys={slotKeys}
          registry={registry}
          fieldInputControlReleases={fieldInputControlReleases}
        />
      ),
    },
  } as unknown as Config;
  const byCatalogue = canvasConfigs.get(baseConfig) ?? new WeakMap();
  const bySlots =
    byCatalogue.get(catalogue) ??
    new Map<string, Readonly<{ shell: Config; repeatingKey: string; config: Config }>>();
  const config = withHeldRepeatingSlots(registry, canvas, repeating);
  bySlots.set(slotsKey, { shell: canvas, repeatingKey, config });
  byCatalogue.set(catalogue, bySlots);
  canvasConfigs.set(baseConfig, byCatalogue);
  return config;
};
