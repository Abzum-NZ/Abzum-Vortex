"use client";

import { Puck, type Data, type PuckAction } from "@puckeditor/core";
import { createPortal } from "react-dom";
import "@puckeditor/core/puck.css";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  compiledItemSlots,
  readSourceItem,
  releaseSettingDeclarations,
  setSourcePageSlot,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type ApplicationSourceDocument,
  type PageSlotAddress,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import type { CompiledItem, SourceItem, SourcePageZone } from "@vortex/platform/schema";
import type { FieldInputControlReleaseMap } from "../registry";
import { createAppearanceRootProps, type PlatformThemeTokens } from "../theme";
import { createPlatformComponentRegistryForReleases } from "../combined-registry";
import { getVortexPuckConfig } from "../puck-config";
import { contentConfigFor } from "../shell-outlet";
import type { Breakpoint } from "../definition-error";

export type { Breakpoint as StudioCanvasBreakpoint } from "../definition-error";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../icons";
import { Alert, AlertTitle, AlertDescription } from "../components/alert";
import { Button } from "../components/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../components/collapsible";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "../components/empty";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import type { StudioCompileFailure } from "./compile-failure";
import {
  StoredCompositionRefusal,
  storedItemRelease,
  storedZoneFromPuck,
  validateStoredZone,
  storedZoneAliases,
  withCopiedFlowBindings,
  removeFlowBindingsOf,
  syncStoredBlockDependencies,
} from "./stored-composition";
import {
  StudioCanvasCompiledSettings,
  studioCanvasConfig,
  StudioCanvasRecordsProvider,
  StudioCanvasViewerProvider,
  type StudioCanvasRecords,
  type StudioCanvasSample,
  type StudioCanvasViewer,
} from "./studio-canvas-render";
import {
  puckDataForBreakpoint,
  StudioCanvasBridge,
  type StudioCanvasFrame,
} from "./studio-canvas-bridge";
import { studioPuckStyle } from "./studio-puck-style";
import { StudioBlockPalette, type StudioCanvasAddRequest } from "./studio-block-palette";
import type {
  StudioCompositionAddTargetsModel,
  StudioCompositionDestination,
} from "./application-composition-commands";

export type { StudioCanvasFrame } from "./studio-canvas-bridge";
export type { StudioCanvasViewer } from "./studio-canvas-render";
export type { StudioCanvasAddRequest } from "./studio-block-palette";

/** Studio's block palette: drawn in the Blocks panel, inside this editor so its blocks drag with Puck. */
export type StudioCanvasPalette = Readonly<{
  /** The Blocks panel element the palette is drawn into. */
  host: HTMLElement | null;
  /** The places on the open page a new block can go. */
  targets: StudioCompositionAddTargetsModel;
  message: string;
  /** Adds a block through Studio's one add command; `false` when nothing was added yet. */
  onAdd: (request: StudioCanvasAddRequest) => boolean;
}>;

/**
 * What a block's records depend on, by block name, at any depth: its release, its typed settings
 * and the query it reads. Records read for one spelling are shown only while the block still has it.
 */
const recordKeys = (
  catalogue: ImmutablePlatformBlockCatalogue,
  items: readonly SourceItem[],
): Map<string, string> => {
  const keys = new Map<string, string>();
  const visit = (list: readonly SourceItem[]): void => {
    for (const item of list) {
      const release = storedItemRelease(catalogue, item);
      if (release === undefined) continue;
      const reading = readSourceItem(item, release);
      keys.set(
        item.props.id,
        canonicalJson([item.props.vortex.block, item.props.vortex.query ?? null, reading.settings]),
      );
      for (const [, slot] of reading.slots) if (slot.items !== undefined) visit(slot.items);
    }
  };
  visit(items);
  return keys;
};

/** The records of the canvas's data blocks for one saved revision, as the workspace read them. */
export type StudioCanvasRecordsRead = Readonly<{
  state: StudioCanvasRecords["state"];
  records: Readonly<Record<string, unknown>>;
  /** Read from a preview still moving to this revision: it is read again shortly. */
  behind?: boolean;
  /** On a page of one record, the record its blocks were read with. */
  sample?: StudioCanvasSample;
}>;

/** One compiled content area: its items, exactly as the published definition holds them. */
type CompiledSlot = readonly CompiledItem[];
type SourceSlot = SourcePageZone;
type CompiledSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * The settings of each block's last compiled version, by block name. The compiled slot holds the
 * compiled version of the same stored items, in the same desktop order and with the same slots,
 * so each stored item reads its compiled item at the same position.
 */
const compiledSettingsFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  stored: readonly SourceItem[],
  compiled: CompiledSlot,
): CompiledSettings => {
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  const visit = (items: readonly SourceItem[], compiledItems: readonly CompiledItem[]): void => {
    if (items.length !== compiledItems.length)
      throw new TypeError("Compiled page placements do not match their stored page.");
    for (const [index, item] of items.entries()) {
      const compiledItem = compiledItems[index]!;
      const release = storedItemRelease(catalogue, item);
      if (release === undefined || item.type !== compiledItem.type)
        throw new TypeError("Compiled page placements do not match their stored page.");
      // Its settings are the props its release declares, as their plain values.
      result[item.props.id] = Object.fromEntries(
        releaseSettingDeclarations(release).flatMap((property) =>
          Object.hasOwn(compiledItem.props, property.key)
            ? [[property.key, compiledItem.props[property.key]]]
            : [],
        ),
      );
      const compiledSlots = new Map(compiledItemSlots(compiledItem));
      for (const [key, { items: children }] of readSourceItem(item, release).slots) {
        if (children === undefined) continue;
        const compiledChildren = compiledSlots.get(key);
        if (compiledChildren === undefined)
          throw new TypeError("Compiled page slots do not match their stored page.");
        visit(children, compiledChildren);
      }
    }
  };
  visit(stored, compiled);
  return result;
};

export type ApplicationPagePuckEditorProps = Readonly<{
  source: ApplicationSourceDocument;
  compiledSource: ApplicationSourceDocument;
  platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  pageAlias: string;
  /** The compiled items of each content area of this page, keyed by page slot address key. */
  compiledSlots?: Readonly<Record<string, CompiledSlot>> | undefined;
  disabled: boolean;
  /** Why the saved draft would not compile; the page stays open so the cause can be corrected. */
  compileFailure?: StudioCompileFailure | null | undefined;
  onChange: (expectedSource: ApplicationSourceDocument, source: ApplicationSourceDocument) => void;
  /** The block selected in the workspace, shown selected on the canvas. */
  selectedPlacementAlias: string | null;
  /** A block clicked on the canvas (`null`: the page itself); `false` keeps the workspace selection. */
  onSelectPlacement: (alias: string | null) => Promise<boolean>;
  /** The screen size the canvas shows; Studio's canvas toolbar chooses it and keeps it while pages change. */
  breakpoint: Breakpoint;
  /** Device width is preserved while the page frame scales inside the well. */
  zoom: number | "fit";
  appearance: "light" | "dark";
  /** The application frame the page is drawn inside, when the draft compiled. */
  frame?: StudioCanvasFrame | undefined;
  /** The block palette of the Blocks panel. */
  palette?: StudioCanvasPalette | undefined;
  /**
   * Reads the records of one content area's data blocks for the saved revision `compiledSource`
   * is. The canvas reads again whenever a newer saved revision is compiled.
   */
  readRecords?: ((area: string) => Promise<StudioCanvasRecordsRead>) | undefined;
  /** A newer saved revision than `compiledSource` is being compiled. */
  updating?: boolean | undefined;
  /** The role the canvas previews, hiding what it may not see; `null` or absent is the design view. */
  viewer?: StudioCanvasViewer | null | undefined;
}>;

/** Edits one content slot of a page; a page with several slots or guided steps lets the person pick. */

const isItemList = (value: unknown): value is SourceItem[] =>
  Array.isArray(value) &&
  value.every(
    (entry) => entry !== null && typeof entry === "object" && "type" in entry && "props" in entry,
  );

const itemsHold = (items: readonly SourceItem[], alias: string): boolean =>
  items.some(
    (item) =>
      item.props.id === alias ||
      Object.values(item.props).some((value) => isItemList(value) && itemsHold(value, alias)),
  );

const slotHolds = (slot: SourceSlot, alias: string): boolean => itemsHold(slot.items, alias);

/** Whether Puck holds a block just dropped from the palette: one without its stored metadata yet. */
const holdsDroppedBlock = (items: readonly unknown[]): boolean =>
  items.some((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const props = (entry as { props?: Record<string, unknown> }).props;
    if (props === undefined || props.vortex === undefined) return true;
    return Object.values(props).some(
      (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((child) => child !== null && typeof child === "object" && "props" in child) &&
        holdsDroppedBlock(value),
    );
  });

/** Puck's name of a slot, `<block name>:<slot key>`, or its root zone, as a place for a new block. */
const destinationOfZone = (zone: string): StudioCompositionDestination => {
  if (zone === "root:default-zone") return { kind: "root" };
  const separator = zone.lastIndexOf(":");
  return {
    kind: "child",
    parentAlias: zone.slice(0, separator),
    slotKey: zone.slice(separator + 1),
  };
};

/** Draws the palette into the Blocks panel. */
const inPalette = (palette: StudioCanvasPalette | undefined, content: ReactNode) =>
  palette?.host === null || palette?.host === undefined
    ? null
    : createPortal(content, palette.host);

export function ApplicationPagePuckEditor(props: ApplicationPagePuckEditorProps) {
  const page = props.source.body.pages.find((candidate) => candidate.id === props.pageAlias);
  const addresses = page === undefined ? [] : sourcePageSlotAddresses(page);
  const [selectedKey, setSelectedKey] = useState("");
  // A block selected in the outline is shown in the content slot that holds it.
  const holding =
    props.selectedPlacementAlias === null || page === undefined
      ? undefined
      : addresses.find((candidate) =>
          slotHolds(sourcePageSlotAt(page, candidate)!, props.selectedPlacementAlias!),
        );
  useEffect(() => {
    if (holding !== undefined && holding.key !== selectedKey) setSelectedKey(holding.key);
  }, [holding?.key]);
  const at =
    addresses.find((candidate) => candidate.key === selectedKey) ?? holding ?? addresses[0];
  const selectorId = `puck-slot-${props.pageAlias}`;
  if (at === undefined)
    return (
      <CanvasEmpty
        title="No content area"
        description="This page has no content area to arrange."
      />
    );
  return (
    <div className="space-y-3">
      {addresses.length < 2 ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={selectorId}>Content area</Label>
          <NativeSelect
            id={selectorId}
            value={at.key}
            onChange={(event) => setSelectedKey(event.target.value)}
          >
            {addresses.map((candidate) => (
              <NativeSelectOption key={candidate.key} value={candidate.key}>
                {candidate.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      <ApplicationPageSlotPuckEditor key={`${props.pageAlias}:${at.key}`} {...props} at={at} />
    </div>
  );
}

const deviceWidths: Readonly<Record<Breakpoint, number>> = {
  desktop: 1280,
  tablet: 820,
  phone: 390,
};

function CanvasEmpty({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <Empty role="status" className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name="blocks" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The canonical form of an authored zone for comparison. A zone with no responsive order carries
 * `order: undefined`, and optional item metadata may be absent; JSON drops both, so equal zones
 * compare equal and canonicalJson never sees an undefined property.
 */
const zoneJson = (zone: SourceSlot): string =>
  canonicalJson(JSON.parse(JSON.stringify(zone)) as unknown);

/**
 * Why a content area is not editable on the canvas: its stored data does not pass the stored
 * composition check, or its compiled version does not match it. Such a content area is shown
 * read-only rather than risking a silent change to the definition.
 */
const storedDataProblem = (
  catalogue: ImmutablePlatformBlockCatalogue,
  slot: SourceSlot,
): string | undefined => {
  try {
    const checked = validateStoredZone(catalogue, slot);
    return zoneJson(checked) === zoneJson(slot)
      ? undefined
      : "STUDIO_CANVAS_STORED_DATA_MISMATCH: the stored content reads back differently";
  } catch (error: unknown) {
    return `STUDIO_CANVAS_STORED_DATA_REFUSED: ${error instanceof Error ? error.message : String(error)}`;
  }
};

function ApplicationPageSlotPuckEditor({
  source,
  compiledSource,
  pageAlias,
  compiledSlots,
  platformBlockCatalogue,
  fieldInputControlReleases,
  platformThemeTokens,
  at,
  disabled,
  compileFailure,
  onChange,
  selectedPlacementAlias,
  onSelectPlacement,
  frame,
  breakpoint,
  zoom,
  appearance,
  palette,
  readRecords,
  updating,
  viewer,
}: ApplicationPagePuckEditorProps & { at: PageSlotAddress }) {
  const well = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const width = deviceWidths[breakpoint];
  const scale = zoom === "fit" ? Math.min(1, availableWidth / width) : zoom / 100;
  const registry = useMemo(
    () => createPlatformComponentRegistryForReleases(platformBlockCatalogue.releases),
    [platformBlockCatalogue],
  );
  const catalogue = useMemo(() => registry.toPlatformBlockCatalogue(), [registry]);
  // The content renders inside the frame's outlet, exactly as a running page's content does.
  const config = useMemo(
    () =>
      studioCanvasConfig(
        contentConfigFor(getVortexPuckConfig(registry, fieldInputControlReleases)),
        registry,
      ),
    [registry, fieldInputControlReleases],
  );
  const compiledSlot = compiledSlots?.[at.key];
  const [message, setMessage] = useState("");
  const [resync, setResync] = useState(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const page = source.body.pages.find((candidate) => candidate.id === pageAlias);
  // A zone is read fresh from its page, so it is kept per page object and address.
  const slot = useMemo(
    () => (page === undefined ? undefined : sourcePageSlotAt(page, at)),
    [page, at.key],
  );
  const originalPage = compiledSource.body.pages.find((candidate) => candidate.id === pageAlias);
  const originalSlot = useMemo(
    () => (originalPage === undefined ? undefined : sourcePageSlotAt(originalPage, at)),
    [originalPage, at.key],
  );
  // The compiled version is read once per compile; a mismatch keeps the canvas closed.
  const compiled = useMemo((): { settings?: CompiledSettings; problem?: string } => {
    if (originalSlot === undefined || compiledSlot === undefined) return {};
    try {
      return { settings: compiledSettingsFor(catalogue, originalSlot.items, compiledSlot) };
    } catch (error: unknown) {
      return {
        problem: `STUDIO_CANVAS_COMPILED_MISMATCH: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }, [catalogue, compiledSlot, originalSlot]);
  // Puck's data is the stored content area itself; Puck only needs a root beside it, holding the
  // config's root defaults that Puck writes into it anyway.
  const rootProps = useMemo(() => ({ ...config.root?.defaultProps }), [config]);
  const data = useMemo(
    (): Data | undefined =>
      slot === undefined || compiled.settings === undefined
        ? undefined
        : { root: { props: rootProps }, content: slot.items as unknown as Data["content"] },
    [compiled.settings, slot, rootProps],
  );
  // Checked whenever the content area or its compiled version changes, and closed until it passes.
  // Without a compiled version there is nothing to draw yet.
  const readOnlyCause = useMemo(
    () =>
      slot === undefined || compiled.settings === undefined
        ? (compiled.problem ?? "STUDIO_CANVAS_COMPILED_PENDING: no compiled version to draw from")
        : storedDataProblem(catalogue, slot),
    [catalogue, slot, compiled],
  );
  useEffect(() => {
    if (readOnlyCause !== undefined && compiledSlot !== undefined)
      console.error(
        `[studio] canvas content area ${pageAlias}/${at.key} is read-only`,
        readOnlyCause,
      );
  }, [readOnlyCause]);
  const shown = useMemo(
    () => (data === undefined ? undefined : puckDataForBreakpoint(data, breakpoint, slot?.order)),
    [data, breakpoint, slot],
  );

  // The records of this area's data blocks, read for the saved revision the compiled version is,
  // with each data block's release, settings and query in that revision.
  const savedKeys = useMemo(
    () => recordKeys(catalogue, originalSlot?.items ?? []),
    [catalogue, originalSlot],
  );
  const [recordsRead, setRecordsRead] = useState<
    StudioCanvasRecordsRead & {
      source?: ApplicationSourceDocument;
      keys?: ReadonlyMap<string, string>;
    }
  >({ state: "loading", records: {} });
  // A preview still moving to this revision is read again shortly; the records shown meanwhile stay.
  const [followed, setFollowed] = useState<
    Readonly<{ source?: ApplicationSourceDocument; area?: string; count: number }>
  >({ count: 0 });
  const followUp =
    followed.source === compiledSource && followed.area === at.key ? followed.count : 0;
  useEffect(() => {
    if (readRecords === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    readRecords(at.key).then(
      (read) => {
        if (cancelled) return;
        const again = read.behind === true && followUp < 30;
        // A read that failed for a moment is tried again, and what is shown meanwhile stays.
        if (read.state !== "unavailable" || !again)
          setRecordsRead({ ...read, source: compiledSource, keys: savedKeys });
        if (again)
          timer = setTimeout(
            () => setFollowed({ source: compiledSource, area: at.key, count: followUp + 1 }),
            1500,
          );
      },
      (error: unknown) => {
        console.error("[studio] the canvas records could not be read", error);
        if (!cancelled)
          setRecordsRead({
            state: "unavailable",
            records: {},
            source: compiledSource,
            keys: savedKeys,
          });
      },
    );
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [readRecords, compiledSource, at.key, followUp]);
  // Records read for another saved revision are never shown as this one's, except while this
  // revision's own read runs after a presentation edit: every data block is still exactly as it
  // was read (same release, settings and query), so its records are the same.
  const carried =
    recordsRead.source !== compiledSource &&
    recordsRead.state === "ready" &&
    recordsRead.keys !== undefined &&
    [...savedKeys].every(([id, key]) => recordsRead.keys?.get(id) === key);
  const canvasRecords = useMemo(
    (): StudioCanvasRecords => ({
      ...(recordsRead.source === compiledSource || carried
        ? recordsRead
        : { state: "loading", records: {} }),
      saved: savedKeys,
      current: recordKeys(catalogue, slot?.items ?? []),
      updating: updating === true,
    }),
    [recordsRead, compiledSource, carried, catalogue, savedKeys, slot, updating],
  );
  useEffect(() => {
    const element = well.current;
    if (element === null) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setAvailableWidth(
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown !== undefined]);
  const editable = !disabled && readOnlyCause === undefined && breakpoint === "desktop";

  // Every canvas change goes back through the definition: Puck's data is converted to the
  // authored content area, placed in the current draft and validated before the history takes it.
  const change = (candidate: Data) => {
    if (!editable) return;
    // A block dropped from the palette is added by Studio's add command, not by this edit.
    if (holdsDroppedBlock(candidate.content as unknown[])) return;
    try {
      const current = sourceRef.current;
      const matches = current.body.pages.filter((item) => item.id === pageAlias);
      const target = matches[0];
      const targetSlot = target === undefined ? undefined : sourcePageSlotAt(target, at);
      if (matches.length !== 1 || targetSlot === undefined)
        throw new TypeError("The selected page is unavailable.");
      const { zone: editedSlot, copies } = storedZoneFromPuck(
        catalogue,
        targetSlot,
        candidate,
        rootProps,
      );
      // Puck reports the draft it was just given (after Undo, Redo or a save) as a change too.
      if (zoneJson(editedSlot) === zoneJson(targetSlot)) return;
      const next = structuredClone(current);
      const nextPage = next.body.pages.find((item) => item.id === pageAlias);
      if (nextPage === undefined || !setSourcePageSlot(nextPage, at, editedSlot))
        throw new TypeError("The selected page is unavailable.");
      const kept = storedZoneAliases(editedSlot);
      const removed = new Set(
        [...storedZoneAliases(targetSlot)].filter((alias) => !kept.has(alias)),
      );
      next.body.flow_bindings = withCopiedFlowBindings(next.body.flow_bindings, copies);
      removeFlowBindingsOf(next.body, removed);
      syncStoredBlockDependencies(next);
      const parsed = applicationSourceDocumentSchema.safeParse(next);
      if (!parsed.success) throw parsed.error;
      setMessage("");
      onChange(current, parsed.data);
    } catch (error: unknown) {
      console.error("Failed to apply Puck page changes", error);
      // Puck keeps the refused change in its own state; show the accepted draft again.
      setResync((generation) => generation + 1);
      setMessage(
        error instanceof StoredCompositionRefusal
          ? `This page change could not be applied. ${error.message}. The saved draft and current edits are preserved.`
          : "This page change could not be applied. The saved draft and current edits are preserved.",
      );
    }
  };

  // A drop from the palette: Puck has put a bare block in its own data; Studio adds the real one.
  const dropped = (action: PuckAction) => {
    if (action.type !== "insert") return;
    const request: StudioCanvasAddRequest = {
      area: at.key,
      destination: destinationOfZone(action.destinationZone),
      index: action.destinationIndex,
      rendererKey: action.componentType,
    };
    // After Puck finishes its own insert: show the stored draft again unless the add went through.
    setTimeout(() => {
      if (!editable || palette?.onAdd(request) !== true) setResync((generation) => generation + 1);
    }, 0);
  };
  const paletteNote = (text: string) =>
    inPalette(palette, <CanvasEmpty title="Blocks unavailable" description={text} />);
  const placesHere =
    palette?.targets.kind === "available"
      ? palette.targets.targets.filter((target) => target.area === at.key)
      : [];

  if (page === undefined || slot === undefined)
    return (
      <CanvasEmpty
        title="Content area unavailable"
        description="Choose another page or content area to keep working."
      />
    );
  if (data === undefined || shown === undefined)
    return (
      <section className="space-y-3" aria-label="Page canvas">
        {paletteNote(
          "Blocks can be added once this page has a compiled version, which follows shortly after your latest change is saved.",
        )}
        <CanvasEmpty
          title="Waiting for the canvas"
          description="Your page appears here after its latest saved changes compile."
        />
        {compileFailure === null || compileFailure === undefined ? null : (
          <CompileFailureNotice failure={compileFailure} />
        )}
        {message.length === 0 ? null : <p role="status">{message}</p>}
      </section>
    );

  return (
    <section className="space-y-3" aria-label="Page canvas" aria-busy={disabled}>
      {/* The screen size is chosen in Studio's canvas toolbar. */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="px-4 text-sm text-muted-foreground">
          {readOnlyCause !== undefined
            ? "This part of the page can't be arranged on the canvas yet, so it is shown read-only to keep it exactly as it is. Its blocks can still be changed in the inspector."
            : breakpoint === "desktop"
              ? "Click a block to select it. Drag blocks to rearrange them."
              : `This is the ${breakpoint} layout and order. Rearrange blocks on Desktop, or change this screen's order in the inspector.`}
        </p>
      </div>
      {compileFailure == null ? null : <CompileFailureNotice failure={compileFailure} />}
      {message.length === 0 ? null : (
        <Alert variant="destructive">
          <AlertTitle>Page change refused</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div
        ref={well}
        data-vortex-studio-canvas-well=""
        className="min-h-96 overflow-x-auto bg-muted/40 px-8"
      >
        <div
          {...createAppearanceRootProps(appearance)}
          data-vortex-studio-page-frame=""
          className="mx-auto my-8 overflow-hidden rounded-xl bg-background shadow-lg ring-1 ring-border"
          style={
            {
              ...createAppearanceRootProps(appearance).style,
              width,
              zoom: scale > 0 ? scale : 1,
              visibility: zoom === "fit" && availableWidth === 0 ? "hidden" : "visible",
              ...studioPuckStyle,
            } as CSSProperties
          }
        >
          <StudioCanvasCompiledSettings settings={compiled.settings ?? {}}>
            <StudioCanvasRecordsProvider records={canvasRecords}>
              <StudioCanvasViewerProvider viewer={viewer ?? null}>
                <Puck
                  config={config}
                  data={shown}
                  onChange={change}
                  onAction={dropped}
                  iframe={{ enabled: false }}
                  metadata={{ breakpoint }}
                  permissions={{
                    drag: editable,
                    duplicate: editable,
                    delete: editable,
                    edit: false,
                    insert: false,
                  }}
                >
                  {palette?.targets.kind !== "available"
                    ? paletteNote(
                        palette?.targets.kind === "unsupported"
                          ? "Blocks can't be added to this kind of page in Studio yet."
                          : "This page is not in the current draft.",
                      )
                    : inPalette(
                        palette,
                        <StudioBlockPalette
                          targets={placesHere}
                          editable={editable}
                          message={palette.message}
                          onAdd={(request) => {
                            palette.onAdd(request);
                          }}
                        />,
                      )}
                  <StudioCanvasBridge
                    data={shown}
                    resync={resync}
                    selectedAlias={selectedPlacementAlias}
                    onSelect={onSelectPlacement}
                    frame={frame}
                    breakpoint={breakpoint}
                    registry={registry}
                    fieldInputControlReleases={fieldInputControlReleases}
                    platformThemeTokens={platformThemeTokens}
                  />
                </Puck>
              </StudioCanvasViewerProvider>
            </StudioCanvasRecordsProvider>
          </StudioCanvasCompiledSettings>
        </div>
      </div>
    </section>
  );
}

const tokenLabel = (key: string): string =>
  key.replace(/_/gu, " ").replace(/^./u, (first) => first.toUpperCase());

function CompileFailureNotice({ failure }: Readonly<{ failure: StudioCompileFailure }>) {
  const alias = failure.blockAlias;
  return (
    <Alert variant="destructive">
      <AlertTitle>This draft does not compile</AlertTitle>
      <AlertDescription>
        <p>Fix the draft to update the canvas. Your edits are preserved.</p>
        <Collapsible>
          <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
            Details
            <Icon name="chevron-down" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            Reason {failure.reasonCode} ({failure.family})
            {alias === undefined ? "" : `, block ${alias}`}
            {failure.tokenKey === undefined ? "" : `, ${tokenLabel(failure.tokenKey)}`}.
          </CollapsibleContent>
        </Collapsible>
      </AlertDescription>
    </Alert>
  );
}
