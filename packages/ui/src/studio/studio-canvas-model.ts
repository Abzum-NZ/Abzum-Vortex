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
  storedItemRelease,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
  type SourcePageData,
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
 * The open page (or the open step of a guided page) the canvas shows, with everything the canvas
 * needs to draw and check it: the Puck config for its root slots, its stored data, the compiled
 * settings of its blocks, the data Puck is given and whether it may be arranged on the canvas.
 */
export type StudioCanvasModel = Readonly<{
  catalogue: ImmutablePlatformBlockCatalogue;
  registry: PlatformComponentRegistry;
  /** The Puck config, with one root slot per content slot of the page's shell. */
  config: Config;
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
  /** Puck's root slot of a page slot address key; `undefined` for the default zone. */
  slotOfZoneKey: (key: string) => string | undefined;
  /** The page slot address key of Puck's root slot, or of the default zone when `undefined`. */
  zoneKeyOfSlot: (slot: string | undefined) => string;
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
  /** Whether the page takes edits: not busy, readable, and on the desktop screen. */
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
    compiledSlots,
    disabled,
    selectedPlacementAlias,
  }: Readonly<{
    source: ApplicationSourceDocument;
    compiledSource: ApplicationSourceDocument;
    platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
    fieldInputControlReleases: FieldInputControlReleaseMap | null;
    pageAlias: string | undefined;
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
  const page = source.body.pages.find((candidate) => candidate.id === pageAlias);
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
  const area = `${pageAlias ?? ""}:${step ?? ""}`;
  // The data is read fresh from its page, so it is kept per page object and step.
  const pageData = useMemo(
    (): SourcePageData | undefined =>
      page === undefined ? undefined : sourcePageDataAt(page, step),
    [page, step],
  );
  const originalPage = compiledSource.body.pages.find((candidate) => candidate.id === pageAlias);
  const originalData = useMemo(
    (): SourcePageData | undefined =>
      originalPage === undefined ? undefined : sourcePageDataAt(originalPage, step),
    [originalPage, step],
  );
  // The page's content slots (its zones) by address key: the canvas shows all of them at once.
  const addresses = useMemo(
    () =>
      page === undefined
        ? []
        : sourcePageSlotAddresses(page).filter((entry) => entry.step === step),
    [page, step],
  );
  const zoneKeyList = useMemo(() => addresses.map((entry) => entry.key), [addresses]);
  const zoneKeys = useMemo(() => new Set(zoneKeyList), [zoneKeyList]);
  // Kept by value: the shells are a new object after every edit of the draft.
  const shellSlotsJson = JSON.stringify(
    Object.fromEntries(
      (
        source.body.shells.find((entry) => entry.id === pageData?.root.props.vortex.shell)
          ?.content_slots ?? []
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
    if (originalPage === undefined || addresses.length === 0) return {};
    try {
      const settings: StudioCanvasCompiledSettings = {};
      for (const entry of addresses) {
        const original = sourcePageSlotAt(originalPage, entry);
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
  }, [catalogue, compiledSlots, originalPage, addresses]);
  // The root slots of the page's shell, named as the shell labels its content slots: Puck's config
  // declares one slot field for each, and the Outline lists them by that name.
  const rootSlotsJson = JSON.stringify(
    pageData === undefined
      ? []
      : sourcePageRootSlots(pageData).map(([key]) => [
          key,
          source.body.shells
            .find((entry) => entry.id === pageData.root.props.vortex.shell)
            ?.content_slots.find((slot) => slot.id === key)?.label ?? key,
        ]),
  );
  const rootSlots = useMemo(
    () => JSON.parse(rootSlotsJson) as readonly (readonly [string, string])[],
    [rootSlotsJson],
  );
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
        : storedDataProblem(catalogue, pageData),
    [catalogue, pageData, compiled],
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
      console.info(`[studio] canvas page ${area} waits for its compiled version`, readOnlyCause);
    else console.error(`[studio] canvas page ${area} is read-only`, readOnlyCause);
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
  const editable = !disabled && readOnlyCause === undefined && breakpoint === "desktop";
  return useMemo(
    () => ({
      catalogue,
      registry,
      config,
      page,
      steps,
      step,
      chooseStep,
      area,
      zoneKeys,
      zoneKeyList,
      slotKeys,
      slotOfZoneKey,
      zoneKeyOfSlot,
      items,
      originalItems,
      compiledSettings: compiled.settings,
      data,
      shown,
      readOnlyCause,
      editable,
      arrangeable,
    }),
    [
      catalogue,
      registry,
      config,
      page,
      steps,
      step,
      chooseStep,
      area,
      zoneKeys,
      zoneKeyList,
      slotKeys,
      slotOfZoneKey,
      zoneKeyOfSlot,
      items,
      originalItems,
      compiled.settings,
      data,
      shown,
      readOnlyCause,
      editable,
      arrangeable,
    ],
  );
};
