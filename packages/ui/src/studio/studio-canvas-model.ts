import type { Config, Data } from "@puckeditor/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definitionLimits,
  immutablePlatformBlockCatalogueSchema,
  sourceItemTree,
  sourcePageDataAt,
  sourcePageRootSlots,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  sourcePageZones,
  shellLayoutZone,
  storedItemRelease,
  storedShellReservations,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type PageSlotAddress,
  type SourceItem,
  type SourceZonedData,
} from "@vortex/platform/schema";
import { createPlatformComponentRegistryForReleases } from "../combined-registry";
import type { Breakpoint } from "../definition-error";
import { getVortexPuckConfig } from "../puck-config";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import {
  compiledSettingsFor,
  itemsHold,
  storedDataProblem,
  type StudioCanvasCompiledSettings,
  type StudioCanvasCompiledSlot,
} from "./studio-canvas-data";
import { puckDataForBreakpoint } from "./studio-canvas-projection";
import { studioCanvasGridSetup } from "./studio-canvas-grid";
import { studioCanvasConfig } from "./studio-canvas-render";

type SourcePage = ApplicationSourceDocument["body"]["pages"][number];

/** What Puck holds before a page is drawn: no page, so no blocks. */
const NO_COMPONENTS = { components: {} } as unknown as Config;

/**
 * The open page (or the open step of a guided page, or the selected layout) the canvas shows, with
 * everything the canvas needs to draw and check it: the Puck config for its root slots, its stored data, the compiled
 * settings of its blocks, the data Puck is given and whether it may be arranged on the canvas.
 */
export type StudioCanvasModel = Readonly<{
  catalogue: ImmutablePlatformBlockCatalogue;
  registry: PlatformComponentRegistry;
  /** The Puck config, with one root slot per content slot of the page's shell. */
  config: Config;
  /** The keys of the root slots the config declares: Puck is opened again when they change. */
  slotsKey: string;
  /** What the canvas shows the blocks of: the open page, or the selected layout (its blocks are Puck's content). */
  owner: "page" | "layout";
  /** Whether the page or layout to show exists in the draft. */
  open: boolean;
  /** The open page; `undefined` when a layout is shown. */
  page: SourcePage | undefined;
  /** The guided steps of the open page, or none; the tabs above the canvas choose among them. */
  steps: readonly Readonly<{ id: string; name: string }>[];
  /** The step on the canvas; `undefined` on a page without steps. */
  step: string | undefined;
  chooseStep: (step: string) => void;
  /** The page and step together, which changes whenever the canvas shows another. */
  area: string;
  /** The page slot address keys of the zones the canvas shows. */
  zoneKeys: ReadonlySet<string>;
  zoneKeyList: readonly string[];
  /** By root slot of the page, the key of the shell content slot it is. */
  slotKeys: Readonly<Record<string, string>>;
  /**
   * The zone the Blocks panel adds to unless the person chose another: the one that holds the
   * selected block, else the first zone the shell requires (the main content), else the first.
   */
  defaultZoneKey: string | undefined;
  /** Puck's root slot of a page slot address key; `undefined` for the default zone. */
  slotOfZoneKey: (key: string) => string | undefined;
  /** The page slot address key of Puck's root slot, or of the default zone when `undefined`. */
  zoneKeyOfSlot: (slot: string | undefined) => string;
  /**
   * With a layout on the canvas, the content slots it declares by the block and slot each one
   * targets: the canvas draws "Page content" there. Empty for a page.
   */
  contentTargets: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Every block of the page data on the canvas, in every zone. */
  items: readonly SourceItem[];
  /** The same blocks in the compiled revision. */
  originalItems: readonly SourceItem[];
  compiledSettings: StudioCanvasCompiledSettings | undefined;
  /** The data Puck holds on the desktop; `undefined` until the page has a compiled version. */
  data: Data | undefined;
  /** The data for the screen size on show. */
  shown: Data | undefined;
  /** Why the page is shown read-only; `undefined` when it can be arranged. */
  readOnlyCause: string | undefined;
  /** Whether the blocks of a slot can be reordered, on any screen: not busy and readable. */
  orderable: boolean;
  /** Whether the page takes every other edit too: orderable, and on the desktop screen. */
  editable: boolean;
  /** Whether a data grid of the page has columns the person can arrange. */
  arrangeable: boolean;
}>;

export const useStudioCanvasModel = (
  {
    source,
    compiledSource,
    platformBlockCatalogue,
    fieldInputControlReleases,
    pageAlias,
    layoutAlias,
    compiledSlots,
    disabled,
    selectedPlacementAlias,
  }: Readonly<{
    source: ApplicationSourceDocument;
    compiledSource: ApplicationSourceDocument;
    platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
    fieldInputControlReleases: FieldInputControlReleaseMap | null;
    pageAlias: string | undefined;
    /** The selected layout: the canvas shows its blocks, and the page above only frames them. */
    layoutAlias: string | undefined;
    compiledSlots?: Readonly<Record<string, StudioCanvasCompiledSlot>> | undefined;
    disabled: boolean;
    selectedPlacementAlias: string | null;
  }>,
  /** The screen the canvas previews. */
  breakpoint: Breakpoint,
): StudioCanvasModel => {
  const registry = useMemo(
    () => createPlatformComponentRegistryForReleases(platformBlockCatalogue.releases),
    [platformBlockCatalogue],
  );
  // The registered releases as an immutable catalogue for the editor's pure compilation snapshots.
  const catalogue = useMemo(
    () =>
      immutablePlatformBlockCatalogueSchema.parse({
        compositionPolicy: {
          maximumDepth: definitionLimits.compositionDepth,
          maximumPlacements: definitionLimits.compositionPlacements,
        },
        releases: [...registry.getReleases()].sort(
          (first, second) =>
            first.blockId.localeCompare(second.blockId) ||
            first.releaseVersion.localeCompare(second.releaseVersion),
        ),
      }),
    [registry],
  );
  const layout = layoutAlias !== undefined;
  const shell = layout
    ? source.body.shells.find((candidate) => candidate.id === layoutAlias)
    : undefined;
  const page = layout
    ? undefined
    : source.body.pages.find((candidate) => candidate.id === pageAlias);
  const steps = useMemo(
    () =>
      page === undefined || page.type !== "guided_form"
        ? []
        : page.steps.map((entry) => ({ id: entry.id, name: entry.name })),
    [page],
  );
  // The guided step the person chose on this page; another page starts from its first.
  const [chosen, setChosen] = useState<Readonly<{ page: string; step: string }> | null>(null);
  const chosenStep = chosen !== null && chosen.page === pageAlias ? chosen.step : "";
  // A block selected in the outline is shown in the step that holds it.
  const holding =
    selectedPlacementAlias === null || page === undefined || steps.length === 0
      ? undefined
      : steps.find((entry) => {
          const data = sourcePageDataAt(page, entry.id);
          return (
            data !== undefined &&
            itemsHold(
              sourcePageZones(data).flatMap(([, list]) => list),
              selectedPlacementAlias,
            )
          );
        });
  useEffect(() => {
    if (pageAlias !== undefined && holding !== undefined && holding.id !== chosenStep)
      setChosen({ page: pageAlias, step: holding.id });
  }, [holding?.id, pageAlias]);
  const step =
    steps.length === 0
      ? undefined
      : (steps.find((entry) => entry.id === chosenStep) ?? holding ?? steps[0])?.id;
  const area = layout ? `layout:${layoutAlias}` : `${pageAlias ?? ""}:${step ?? ""}`;
  // The data is read fresh from its page, so it is kept per page object and step.
  const pageData = useMemo(
    (): SourceZonedData | undefined =>
      layout ? shell?.layout : page === undefined ? undefined : sourcePageDataAt(page, step),
    [layout, shell?.layout, page, step],
  );
  const originalPage = layout
    ? undefined
    : compiledSource.body.pages.find((candidate) => candidate.id === pageAlias);
  const originalShell = layout
    ? compiledSource.body.shells.find((candidate) => candidate.id === layoutAlias)
    : undefined;
  const originalData = useMemo(
    (): SourceZonedData | undefined =>
      layout
        ? originalShell?.layout
        : originalPage === undefined
          ? undefined
          : sourcePageDataAt(originalPage, step),
    [layout, originalShell?.layout, originalPage, step],
  );
  // The page's content slots (its zones) by address key, or the layout's one zone: the canvas shows all of them at once.
  const layoutOpen = shell !== undefined;
  const addresses = useMemo(
    (): readonly PageSlotAddress[] =>
      layout
        ? layoutOpen
          ? [{ key: shellLayoutZone }]
          : []
        : page === undefined
          ? []
          : sourcePageSlotAddresses(page).filter((entry) => entry.step === step),
    [layout, layoutOpen, page, step],
  );
  const zoneKeyList = useMemo(() => addresses.map((entry) => entry.key), [addresses]);
  const zoneKeys = useMemo(() => new Set(zoneKeyList), [zoneKeyList]);
  // Kept by value: the shells are a new object after every edit of the draft.
  const frameAlias = (data: SourceZonedData | undefined): string | null =>
    (data?.root.props.vortex as { shell?: string | null } | undefined)?.shell ?? null;
  const shellSlotsJson = JSON.stringify(
    Object.fromEntries(
      (
        source.body.shells.find((entry) => entry.id === frameAlias(pageData))?.content_slots ?? []
      ).map((slot) => [slot.id, slot.key]),
    ),
  );
  const slotKeys = useMemo(
    () => JSON.parse(shellSlotsJson) as Readonly<Record<string, string>>,
    [shellSlotsJson],
  );
  const slotOfZoneKey = useCallback(
    (key: string) => addresses.find((entry) => entry.key === key)?.slot,
    [addresses],
  );
  const zoneKeyOfSlot = useCallback(
    (slot: string | undefined) => addresses.find((entry) => entry.slot === slot)?.key ?? "",
    [addresses],
  );
  const defaultZoneKey = useMemo(() => {
    if (layout) return addresses[0]?.key;
    if (page === undefined) return undefined;
    const shell = source.body.shells.find((entry) => entry.id === frameAlias(pageData));
    const holding =
      selectedPlacementAlias === null
        ? undefined
        : addresses.find((entry) =>
            itemsHold(sourcePageSlotAt(page, entry)?.items ?? [], selectedPlacementAlias),
          );
    const required = addresses.find(
      (entry) => shell?.content_slots.find((slot) => slot.id === entry.slot)?.required === true,
    );
    return (holding ?? required ?? addresses[0])?.key;
  }, [layout, page, source, pageData, addresses, selectedPlacementAlias]);
  // Kept by value: the shells are a new object after every edit of the draft.
  const contentTargetsJson = JSON.stringify(
    shell === undefined
      ? []
      : shell.content_slots.map((slot) => [slot.parent_placement, slot.parent_slot, slot.label]),
  );
  const contentTargets = useMemo(() => {
    const targets: Record<string, Record<string, string>> = {};
    for (const [placement, slot, label] of JSON.parse(contentTargetsJson) as string[][])
      (targets[placement!] ??= {})[slot!] = label!;
    return targets;
  }, [contentTargetsJson]);
  const items = useMemo(
    () => (pageData === undefined ? [] : sourcePageZones(pageData).flatMap(([, list]) => list)),
    [pageData],
  );
  const originalItems = useMemo(
    () =>
      originalData === undefined ? [] : sourcePageZones(originalData).flatMap(([, list]) => list),
    [originalData],
  );
  // The compiled version is read once per compile; a mismatch keeps the canvas closed.
  const compiled = useMemo((): { settings?: StudioCanvasCompiledSettings; problem?: string } => {
    if ((layout ? originalShell : originalPage) === undefined || addresses.length === 0) return {};
    try {
      const settings: StudioCanvasCompiledSettings = {};
      for (const entry of addresses) {
        const original = layout
          ? { items: originalShell!.layout.content }
          : sourcePageSlotAt(originalPage!, entry);
        const compiledSlot = compiledSlots?.[entry.key];
        if (original === undefined || compiledSlot === undefined) return {};
        Object.assign(settings, compiledSettingsFor(catalogue, original.items, compiledSlot));
      }
      return { settings };
    } catch (error: unknown) {
      return {
        problem: `STUDIO_CANVAS_COMPILED_MISMATCH: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }, [catalogue, compiledSlots, layout, originalShell, originalPage, addresses]);
  // The root slots of the page's shell, named as the shell labels its content slots: Puck's config
  // declares one slot field for each, and the Outline lists them by that name.
  const rootSlotsJson = JSON.stringify(
    pageData === undefined
      ? []
      : sourcePageRootSlots(pageData).map(([key]) => [
          key,
          source.body.shells
            .find((entry) => entry.id === frameAlias(pageData))
            ?.content_slots.find((slot) => slot.id === key)?.label ?? key,
        ]),
  );
  const rootSlots = useMemo(
    () => JSON.parse(rootSlotsJson) as readonly (readonly [string, string])[],
    [rootSlotsJson],
  );
  // Puck is opened again only when the set of root slots changes; a label alone changes the config.
  const slotsKey = useMemo(() => rootSlots.map(([key]) => key).join(" "), [rootSlots]);
  // The application frame is the canvas root, so the page renders in its outlets inside the iframe.
  const config = useMemo(
    () =>
      fieldInputControlReleases === null
        ? NO_COMPONENTS
        : studioCanvasConfig(
            getVortexPuckConfig(registry, fieldInputControlReleases),
            registry,
            fieldInputControlReleases,
            catalogue,
            rootSlots,
          ),
    [registry, fieldInputControlReleases, catalogue, rootSlots],
  );
  // Puck's data is the stored page data itself: the root holds the shell and one slot per outlet.
  const data = useMemo(
    (): Data | undefined =>
      pageData === undefined || compiled.settings === undefined
        ? undefined
        : (pageData as unknown as Data),
    [compiled.settings, pageData],
  );
  // Checked whenever the page or its compiled version changes, and closed until it passes.
  // Without a compiled version there is nothing to draw yet.
  const readOnlyCause = useMemo(
    () =>
      pageData === undefined || compiled.settings === undefined
        ? (compiled.problem ?? "STUDIO_CANVAS_COMPILED_PENDING: no compiled version to draw from")
        : storedDataProblem(
            catalogue,
            pageData,
            layout && shell !== undefined ? storedShellReservations(shell) : undefined,
          ),
    [catalogue, pageData, compiled, layout, shell],
  );
  useEffect(() => {
    if (
      readOnlyCause === undefined ||
      addresses.every((entry) => compiledSlots?.[entry.key] === undefined)
    )
      return;
    // Waiting for a recompile (a live edit removed the page or step first) is a race; a compiled
    // version that disagrees with its source, or stored data the validator should have refused, is
    // a platform fault.
    if (readOnlyCause.startsWith("STUDIO_CANVAS_COMPILED_PENDING"))
      console.info(`[studio] canvas ${area} waits for its compiled version`, readOnlyCause);
    else console.error(`[studio] canvas ${area} is read-only`, readOnlyCause);
  }, [readOnlyCause]);
  const shown = useMemo(
    () => (data === undefined ? undefined : puckDataForBreakpoint(data, breakpoint)),
    [data, breakpoint],
  );
  const arrangeable = useMemo(
    () =>
      sourceItemTree(items).some((item) => {
        const settings = compiled.settings?.[item.props.id];
        return (
          settings !== undefined &&
          studioCanvasGridSetup(item.props, settings, storedItemRelease(catalogue, item)) !==
            undefined
        );
      }),
    [items, catalogue, compiled],
  );
  const chooseStep = useCallback(
    (next: string) => {
      if (pageAlias !== undefined) setChosen({ page: pageAlias, step: next });
    },
    [pageAlias],
  );
  const orderable = !disabled && readOnlyCause === undefined;
  const editable = orderable && breakpoint === "desktop";
  return useMemo(
    () => ({
      catalogue,
      registry,
      config,
      slotsKey,
      owner: layout ? ("layout" as const) : ("page" as const),
      open: layout ? layoutOpen : page !== undefined,
      page,
      steps,
      step,
      chooseStep,
      area,
      zoneKeys,
      zoneKeyList,
      slotKeys,
      defaultZoneKey,
      slotOfZoneKey,
      zoneKeyOfSlot,
      contentTargets,
      items,
      originalItems,
      compiledSettings: compiled.settings,
      data,
      shown,
      readOnlyCause,
      orderable,
      editable,
      arrangeable,
    }),
    [
      catalogue,
      registry,
      config,
      slotsKey,
      layout,
      layoutOpen,
      page,
      steps,
      step,
      chooseStep,
      area,
      zoneKeys,
      zoneKeyList,
      slotKeys,
      defaultZoneKey,
      slotOfZoneKey,
      zoneKeyOfSlot,
      contentTargets,
      items,
      originalItems,
      compiled.settings,
      data,
      shown,
      readOnlyCause,
      orderable,
      editable,
      arrangeable,
    ],
  );
};
