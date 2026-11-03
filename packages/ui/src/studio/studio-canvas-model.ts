import type { Config, Data } from "@puckeditor/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definitionLimits,
  immutablePlatformBlockCatalogueSchema,
  sourceItemTree,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  storedItemRelease,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type PageSlotAddress,
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
  type StudioCanvasSourceSlot,
} from "./studio-canvas-data";
import { puckDataForBreakpoint } from "./studio-canvas-projection";
import { studioCanvasGridSetup } from "./studio-canvas-grid";
import { studioCanvasConfig } from "./studio-canvas-render";

type SourcePage = ApplicationSourceDocument["body"]["pages"][number];

/** What Puck holds before a page is drawn: no page, so no blocks. */
const NO_COMPONENTS = { components: {} } as unknown as Config;

/**
 * The content area of the open page the canvas shows, with everything the canvas needs to draw
 * and check it: the one Puck config, the stored area, the compiled settings of its blocks, the
 * data Puck is given and whether the area may be arranged on the canvas.
 */
export type StudioCanvasModel = Readonly<{
  catalogue: ImmutablePlatformBlockCatalogue;
  registry: PlatformComponentRegistry;
  config: Config;
  /** The root props Puck writes into its data. */
  rootProps: Readonly<Record<string, unknown>>;
  page: SourcePage | undefined;
  /** The content areas of the open page. */
  addresses: readonly PageSlotAddress[];
  /** The content area on the canvas. */
  at: PageSlotAddress | undefined;
  /** The page and content area together, which changes whenever the canvas shows another. */
  area: string;
  chooseArea: (key: string) => void;
  slot: StudioCanvasSourceSlot | undefined;
  /** The same content area in the compiled revision. */
  originalSlot: StudioCanvasSourceSlot | undefined;
  compiledSettings: StudioCanvasCompiledSettings | undefined;
  /** The data Puck holds on the desktop; `undefined` until the page has a compiled version. */
  data: Data | undefined;
  /** The data for the screen size on show. */
  shown: Data | undefined;
  /** Why the area is shown read-only; `undefined` when it can be arranged. */
  readOnlyCause: string | undefined;
  /** Whether the area takes edits: not busy, readable, and on the desktop screen. */
  editable: boolean;
  /** Whether a data grid of the area has columns the person can arrange. */
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
  // The application frame is the canvas root, so the content renders in its outlet inside the iframe.
  const config = useMemo(
    () =>
      fieldInputControlReleases === null
        ? NO_COMPONENTS
        : studioCanvasConfig(
            getVortexPuckConfig(registry, fieldInputControlReleases),
            registry,
            fieldInputControlReleases,
            catalogue,
          ),
    [registry, fieldInputControlReleases, catalogue],
  );
  const page = source.body.pages.find((candidate) => candidate.id === pageAlias);
  const addresses = useMemo(
    () => (page === undefined ? [] : sourcePageSlotAddresses(page)),
    [page],
  );
  // The content area the person chose on this page; another page starts from its first.
  const [chosen, setChosen] = useState<Readonly<{ page: string; key: string }> | null>(null);
  const chosenKey = chosen !== null && chosen.page === pageAlias ? chosen.key : "";
  // A block selected in the outline is shown in the content slot that holds it.
  const holding =
    selectedPlacementAlias === null || page === undefined
      ? undefined
      : addresses.find((candidate) =>
          itemsHold(sourcePageSlotAt(page, candidate)!.items, selectedPlacementAlias),
        );
  useEffect(() => {
    if (pageAlias !== undefined && holding !== undefined && holding.key !== chosenKey)
      setChosen({ page: pageAlias, key: holding.key });
  }, [holding?.key, pageAlias]);
  const at = addresses.find((candidate) => candidate.key === chosenKey) ?? holding ?? addresses[0];
  const area = `${pageAlias ?? ""}:${at?.key ?? ""}`;
  // A zone is read fresh from its page, so it is kept per page object and address.
  const slot = useMemo(
    () => (page === undefined || at === undefined ? undefined : sourcePageSlotAt(page, at)),
    [page, at?.key],
  );
  const originalPage = compiledSource.body.pages.find((candidate) => candidate.id === pageAlias);
  const originalSlot = useMemo(
    () =>
      originalPage === undefined || at === undefined
        ? undefined
        : sourcePageSlotAt(originalPage, at),
    [originalPage, at?.key],
  );
  const compiledSlot = at === undefined ? undefined : compiledSlots?.[at.key];
  // The compiled version is read once per compile; a mismatch keeps the canvas closed.
  const compiled = useMemo((): { settings?: StudioCanvasCompiledSettings; problem?: string } => {
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
    if (readOnlyCause === undefined || compiledSlot === undefined) return;
    // Waiting for a recompile (a live edit removed the page or area first) is a race; a compiled
    // version that disagrees with its source, or stored data the validator should have refused, is
    // a platform fault.
    if (readOnlyCause.startsWith("STUDIO_CANVAS_COMPILED_PENDING"))
      console.info(
        `[studio] canvas content area ${area} waits for its compiled version`,
        readOnlyCause,
      );
    else console.error(`[studio] canvas content area ${area} is read-only`, readOnlyCause);
  }, [readOnlyCause]);
  const shown = useMemo(
    () => (data === undefined ? undefined : puckDataForBreakpoint(data, breakpoint, slot?.order)),
    [data, breakpoint, slot],
  );
  const arrangeable = useMemo(
    () =>
      slot === undefined
        ? false
        : sourceItemTree(slot.items).some((item) => {
            const settings = compiled.settings?.[item.props.id];
            return (
              settings !== undefined &&
              studioCanvasGridSetup(item.props, settings, storedItemRelease(catalogue, item)) !==
                undefined
            );
          }),
    [slot, catalogue, compiled],
  );
  const chooseArea = useCallback(
    (key: string) => {
      if (pageAlias !== undefined) setChosen({ page: pageAlias, key });
    },
    [pageAlias],
  );
  const editable = !disabled && readOnlyCause === undefined && breakpoint === "desktop";
  return useMemo(
    () => ({
      catalogue,
      registry,
      config,
      rootProps,
      page,
      addresses,
      at,
      area,
      chooseArea,
      slot,
      originalSlot,
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
      rootProps,
      page,
      addresses,
      at,
      area,
      chooseArea,
      slot,
      originalSlot,
      compiled.settings,
      data,
      shown,
      readOnlyCause,
      editable,
      arrangeable,
    ],
  );
};
