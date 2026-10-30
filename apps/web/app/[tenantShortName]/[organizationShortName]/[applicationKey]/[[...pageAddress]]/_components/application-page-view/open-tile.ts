import type { RefObject } from "react";
import type { useRouter } from "next/navigation";
import {
  projectedLinkTilesSchema,
  type ComponentRequestGeneration,
  type ProjectedLinkTiles,
} from "@vortex/platform/schema";
import type { useUnsavedWorkGuard } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import type { publishedControlData } from "./published-control-data";

/** Open a tile only after re-reading its current authorized target. */
export async function openTile({
  sourceRecordId,
  sourceRevision,
  isVisible,
  pinActivationInFlightRef,
  placementRequestsRef,
  navigationKey,
  currentTileDataRef,
  placementId,
  data,
  pins,
  currentPageKey,
  unsavedWork,
  application,
  currentSearch,
  router,
}: Readonly<{
  sourceRecordId: string;
  sourceRevision: number;
  isVisible?: () => boolean;
  pinActivationInFlightRef: RefObject<boolean>;
  placementRequestsRef: RefObject<{
    base: string;
    key: string;
    generations: Map<string, ComponentRequestGeneration>;
  }>;
  navigationKey: string;
  currentTileDataRef: RefObject<ApplicationPageModel["data"]>;
  placementId: string;
  data: ReturnType<typeof publishedControlData>;
  pins: ProjectedLinkTiles;
  currentPageKey: string | undefined;
  unsavedWork: ReturnType<typeof useUnsavedWorkGuard>["guard"];
  application: ApplicationPageModel["invocation"];
  currentSearch: string;
  router: ReturnType<typeof useRouter>;
}>): Promise<void> {
  if (
    pinActivationInFlightRef.current ||
    placementRequestsRef.current.key !== navigationKey ||
    currentTileDataRef.current[placementId] !== data
  )
    return;
  const rows = pins.rows.filter(
    (row) =>
      row.sourceRecordId.toLowerCase() === sourceRecordId.toLowerCase() &&
      row.sourceRevision === sourceRevision,
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.target.kind === "unavailable") return;
  if (currentPageKey === undefined || typeof isVisible !== "function") return;
  const generation = placementRequestsRef.current.generations.get(placementId.toLowerCase());
  const visible = isVisible;
  const currentSource = () => {
    try {
      return (
        placementRequestsRef.current.key === navigationKey &&
        placementRequestsRef.current.generations.get(placementId.toLowerCase()) === generation &&
        currentTileDataRef.current[placementId] === data &&
        visible()
      );
    } catch {
      return false;
    }
  };
  if (!currentSource()) return;
  pinActivationInFlightRef.current = true;
  try {
    // The unsaved-work wait precedes both source selection and target authority rereads.
    if (
      row.target.openBehaviour === "replace" &&
      unsavedWork.hasUnsavedWork() &&
      !(await unsavedWork.confirmDiscardUnsavedWork())
    )
      return;
    if (!currentSource()) return;
    const refreshed = await rereadApplicationPlacements(
      {
        tenantShortName: application.tenantShortName,
        organizationShortName: application.organizationShortName,
        applicationKey: application.applicationKey,
        pageKey: currentPageKey,
        installationRevision: application.installationRevision,
        search: currentSearch,
      },
      [placementId],
    );
    if (!currentSource()) return;
    if (refreshed.kind === "reload") {
      router.refresh();
      return;
    }
    if (refreshed.kind !== "available") return;
    const state = Object.entries(refreshed.data).find(
      ([id]) => id.toLowerCase() === placementId.toLowerCase(),
    )?.[1];
    if (state?.status !== "ready") return;
    const fresh = projectedLinkTilesSchema.safeParse(state.values);
    if (!fresh.success) return;
    const selected = fresh.data.rows.filter(
      (entry) =>
        entry.sourceRecordId.toLowerCase() === sourceRecordId.toLowerCase() &&
        entry.sourceRevision === sourceRevision,
    );
    const current = selected[0];
    if (
      selected.length !== 1 ||
      current === undefined ||
      current.target.kind === "unavailable" ||
      current.target.kind !== row.target.kind ||
      current.target.openBehaviour !== row.target.openBehaviour
    )
      return;
    const target = current.target;
    // Only the fresh protected tuple supplies an internal address; browser-held metadata is ignored.
    const internal = target.kind !== "external";
    if (
      (target.kind === "application" || target.kind === "page") &&
      (target.tenantShortName !== application.tenantShortName ||
        target.organizationShortName !== application.organizationShortName)
    )
      return;
    const href =
      target.kind === "record"
        ? `/${encodeURIComponent(application.tenantShortName)}/${encodeURIComponent(application.organizationShortName)}/${encodeURIComponent(target.detailAddress.applicationKey)}/${encodeURIComponent(target.detailAddress.pageKey)}?${new URLSearchParams({ record_id: target.detailAddress.recordId })}`
        : target.kind === "external"
          ? target.address
          : `/${encodeURIComponent(target.tenantShortName)}/${encodeURIComponent(target.organizationShortName)}/${encodeURIComponent(target.applicationKey)}/${encodeURIComponent(target.pageKey)}`;
    const address = new URL(href, window.location.origin);
    if (
      (internal && address.origin !== window.location.origin) ||
      (!internal && address.protocol !== "https:") ||
      !currentSource()
    )
      return;
    if (target.openBehaviour === "new_page")
      window.open(address.href, "_blank", "noopener,noreferrer");
    else if (internal) router.push(`${address.pathname}${address.search}`);
    else window.location.assign(address.href);
  } catch {
    // No navigation or target metadata on a failed current protected reread.
  } finally {
    pinActivationInFlightRef.current = false;
  }
}
