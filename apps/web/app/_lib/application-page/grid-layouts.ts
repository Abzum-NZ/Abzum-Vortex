import {
  createHumanOrganizationRequestService,
  readGridViews,
  type HumanOrganizationRequestDependencies,
  type StoredGridView,
} from "@vortex/platform/server";
import type { IdentitySession, OrganizationSelectionCandidate } from "@vortex/platform/schema";

/** The person's stored layouts of a page's data grids, read once before any grid reads its rows. */
export type PageGridLayouts = Readonly<{
  /** False in a preview: changes then stay on screen only. */
  persisted: boolean;
  stored: ReadonlyMap<string, StoredGridView>;
}>;

const NONE: ReadonlyMap<string, StoredGridView> = new Map();

/**
 * Reads every stored layout of the named grid placements in one protected request, so a page with
 * several grids makes one layout read. A preview stores nothing. A failed read is logged and
 * refused; silently showing a different projection would disregard the person's saved layout.
 */
export const readPageGridLayouts = async (
  session: IdentitySession,
  dependencies: HumanOrganizationRequestDependencies,
  selection: OrganizationSelectionCandidate,
  pageId: string,
  placementIds: readonly string[],
): Promise<PageGridLayouts> => {
  if (selection.previewInstallationId !== undefined) return { persisted: false, stored: NONE };
  if (placementIds.length === 0) return { persisted: true, stored: NONE };
  const result = await createHumanOrganizationRequestService(dependencies).run(
    session,
    selection,
    (transaction) => readGridViews(transaction, pageId, placementIds),
  );
  if (result.kind === "available") return { persisted: true, stored: result.value };
  console.error(
    `[page] grid layouts unavailable: code=GRID_LAYOUT_READ_FAILED kind=${result.kind}`,
  );
  throw new Error("GRID_LAYOUT_READ_FAILED", {
    cause: "cause" in result ? result.cause : result.kind,
  });
};
