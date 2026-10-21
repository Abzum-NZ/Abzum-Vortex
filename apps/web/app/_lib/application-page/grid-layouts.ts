import {
  createHumanOrganizationRequestService,
  gridViewPlacement,
  readGridViews,
  type HumanOrganizationRequestDependencies,
  type InstalledRuntimeContext,
  type StoredGridViews,
} from "@vortex/platform/server";
import { readRecordsTableViewId, type GridLayoutStorage } from "@vortex/platform/schema";
import type {
  GridViewDocument,
  IdentitySession,
  OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { first } from "./placement-helpers";
import type { SearchParameters } from "./types";

/**
 * The person's stored layouts and saved views of a page's data grids, read once before any grid
 * reads its rows.
 */
export type PageGridLayouts = Readonly<{
  storage: GridLayoutStorage;
  stored: StoredGridViews;
  /**
   * The columns the person may read now, decided by access route, by lower-cased record type identity:
   * a grid lists, reads and offers only these columns. Undefined in a preview, whose builder sees
   * every field.
   */
  readable: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}>;

const NONE: StoredGridViews = {
  readable: new Map(),
  roleKeys: new Set(),
  shareable: new Set(),
  layouts: new Map(),
  views: new Map(),
  defaultDocuments: new Map(),
};

/** One data grid of the page whose layout and views are read. */
export type PageGrid = Readonly<{
  placementId: string;
  recordTypeId: string;
  /** The saved view the address selects for this grid, when it names one. */
  selectedViewId: string | undefined;
  defaultViews: readonly Readonly<{
    viewId: string;
    queryId: string;
    document: GridViewDocument;
  }>[];
}>;

/** The same authored and addressed views for the initial page and an expanded tree level. */
export const pageGridLayoutRequest = (
  page: InstalledRuntimeContext["releaseSet"]["application"]["content"]["pages"][number],
  placementId: string,
  recordTypeId: string,
  parameters: SearchParameters,
): PageGrid => {
  const installed = gridViewPlacement(page, placementId);
  const feature = installed?.contract.features.savedViews;
  return {
    placementId,
    recordTypeId,
    selectedViewId:
      feature?.enabled === true
        ? readRecordsTableViewId(
            placementId,
            Object.entries(parameters).flatMap(([name, value]): [string, string][] => {
              const text = first(value);
              return text === undefined ? [] : [[name, text]];
            }),
          )
        : undefined,
    defaultViews:
      installed === undefined || feature?.enabled !== true
        ? []
        : feature.defaultViews.map((view) => ({
            viewId: view.viewId,
            queryId: installed.queryId,
            document: view.document,
          })),
  };
};

/**
 * Reads every stored layout of the named grid placements, and the person's current field policy
 * for the record types those grids read (decided by access route, never by scanning records), in one protected request, so a page with several grids
 * makes one layout read. A preview stores nothing. A failed read is logged and refused; silently
 * showing a different projection would disregard the person's saved layout.
 */
export const readPageGridLayouts = async (
  session: IdentitySession,
  dependencies: HumanOrganizationRequestDependencies,
  selection: OrganizationSelectionCandidate,
  pageId: string,
  grids: readonly PageGrid[],
): Promise<PageGridLayouts> => {
  if (selection.previewInstallationId !== undefined)
    return { storage: "preview", stored: NONE, readable: undefined };
  if (grids.length === 0) return { storage: "personal", stored: NONE, readable: new Map() };
  const recordTypeIds = [...new Set(grids.map((grid) => grid.recordTypeId.toLowerCase()))];
  const result = await createHumanOrganizationRequestService(dependencies).run(
    session,
    selection,
    async (transaction) => {
      const stored = await readGridViews(
        transaction,
        pageId,
        grids.map((grid) => grid.placementId),
        grids.flatMap((grid) => (grid.selectedViewId === undefined ? [] : [grid.selectedViewId])),
        recordTypeIds,
        grids.flatMap((grid) => grid.defaultViews),
      );
      return { stored, readable: stored.readable };
    },
  );
  if (result.kind === "available") return { storage: "personal", ...result.value };
  console.error(
    `[page] grid layouts unavailable: code=GRID_LAYOUT_READ_FAILED kind=${result.kind}`,
  );
  throw new Error("GRID_LAYOUT_READ_FAILED", {
    cause: "cause" in result ? result.cause : result.kind,
  });
};
