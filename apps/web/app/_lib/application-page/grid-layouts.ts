import {
  createHumanOrganizationRequestService,
  readGridViews,
  type HumanOrganizationRequestDependencies,
  type InstalledRuntimeContext,
  type StoredGridViews,
} from "@vortex/platform/server";
import type {
  GridViewDocument,
  IdentitySession,
  OrganizationSelectionCandidate,
} from "@vortex/platform/schema";
import { decideRecordTypeFieldIds } from "./form-field-access";

/**
 * The person's stored layouts and saved views of a page's data grids, read once before any grid
 * reads its rows.
 */
export type PageGridLayouts = Readonly<{
  /** False in a preview: changes then stay on screen only. */
  persisted: boolean;
  stored: StoredGridViews;
  /**
   * The fields the person can read on at least one record, by lower-cased record type identity:
   * a grid lists, reads and offers only these columns. Undefined in a preview, whose builder sees
   * every field.
   */
  readable: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}>;

const NONE: StoredGridViews = {
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

/**
 * Reads every stored layout of the named grid placements, and the person's current field policy
 * for the record types those grids read, in one protected request, so a page with several grids
 * makes one layout read. A preview stores nothing. A failed read is logged and refused; silently
 * showing a different projection would disregard the person's saved layout.
 */
export const readPageGridLayouts = async (
  session: IdentitySession,
  dependencies: HumanOrganizationRequestDependencies,
  selection: OrganizationSelectionCandidate,
  context: InstalledRuntimeContext,
  pageId: string,
  grids: readonly PageGrid[],
): Promise<PageGridLayouts> => {
  if (selection.previewInstallationId !== undefined)
    return { persisted: false, stored: NONE, readable: undefined };
  if (grids.length === 0) return { persisted: true, stored: NONE, readable: new Map() };
  const recordTypeIds = [...new Set(grids.map((grid) => grid.recordTypeId.toLowerCase()))];
  const result = await createHumanOrganizationRequestService(dependencies).run(
    session,
    selection,
    async (transaction, scope) => {
      const stored = await readGridViews(
        transaction,
        pageId,
        grids.map((grid) => grid.placementId),
        grids.flatMap((grid) => (grid.selectedViewId === undefined ? [] : [grid.selectedViewId])),
        grids.flatMap((grid) => grid.defaultViews),
      );
      const readable = new Map<string, ReadonlySet<string>>();
      for (const recordTypeId of recordTypeIds)
        readable.set(
          recordTypeId,
          await decideRecordTypeFieldIds(transaction, scope, context, recordTypeId, "read"),
        );
      return { stored, readable };
    },
  );
  if (result.kind === "available") return { persisted: true, ...result.value };
  console.error(
    `[page] grid layouts unavailable: code=GRID_LAYOUT_READ_FAILED kind=${result.kind}`,
  );
  throw new Error("GRID_LAYOUT_READ_FAILED", {
    cause: "cause" in result ? result.cause : result.kind,
  });
};
