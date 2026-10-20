import type { DisplaySemanticEvent } from "@vortex/ui";
import {
  boardColumnReadRequestSchema,
  containedComponentIdSchema,
  isCurrentComponentRequestGeneration,
  nextComponentRequestGeneration,
} from "@vortex/platform/schema";
import { rereadApplicationPlacements } from "../../placement-refresh-action";
import { boardPayloadFor, mergeBoardColumnRead } from "./placement-helpers";
import type { usePlacementActions } from "./use-placement-actions";

type BoardReadInput = Pick<
  Parameters<typeof usePlacementActions>[0],
  | "busy"
  | "placementRequestsRef"
  | "navigationKey"
  | "currentPageKey"
  | "currentData"
  | "boardContinuationInFlightRef"
  | "setRefreshedPlacementData"
  | "refreshPlacements"
  | "application"
  | "currentSearch"
  | "router"
>;

/** The Board-only browser request path is loaded on the first visible-column read. */
export async function readBoardColumns(
  input: BoardReadInput,
  placementId: string,
  event: DisplaySemanticEvent,
): Promise<boolean> {
  const {
    busy,
    placementRequestsRef,
    navigationKey,
    currentPageKey,
    currentData,
    boardContinuationInFlightRef,
    setRefreshedPlacementData,
    refreshPlacements,
    application,
    currentSearch,
    router,
  } = input;
  if (busy || event.event !== "page_changed" || !("columns" in event)) return false;
  const parsedId = containedComponentIdSchema.safeParse(placementId);
  const columnRead = boardColumnReadRequestSchema.safeParse({
    columns: event.columns,
    ...(event.continuationToken === undefined
      ? {}
      : { continuationToken: event.continuationToken }),
  });
  const requestScope = placementRequestsRef.current;
  if (
    !parsedId.success ||
    !columnRead.success ||
    requestScope.key !== navigationKey ||
    currentPageKey === undefined
  )
    return false;

  const displayId =
    Object.keys(currentData).find(
      (candidate) => candidate.toLowerCase() === parsedId.data.toLowerCase(),
    ) ?? parsedId.data;
  const currentBoard = boardPayloadFor(currentData[displayId]);
  if (currentBoard === undefined) return false;

  const serialKey = `${requestScope.key}\u0000${parsedId.data.toLowerCase()}`;
  if (boardContinuationInFlightRef.current.has(serialKey)) return false;
  boardContinuationInFlightRef.current.add(serialKey);
  const request = nextComponentRequestGeneration(
    requestScope.generations.get(parsedId.data.toLowerCase()),
    parsedId.data,
    requestScope.key,
  );
  requestScope.generations.set(parsedId.data.toLowerCase(), request);

  const clearAndReload = (): false => {
    if (
      placementRequestsRef.current.key === requestScope.key &&
      isCurrentComponentRequestGeneration(
        requestScope.generations.get(parsedId.data.toLowerCase()),
        request,
      )
    ) {
      setRefreshedPlacementData((current) => {
        const liveScope = placementRequestsRef.current;
        if (liveScope.key !== requestScope.key) return current;
        const prior = current?.navigationKey === requestScope.key ? current : undefined;
        return {
          navigationKey: requestScope.key,
          data: { ...(prior?.data ?? {}), [displayId]: { status: "error" } },
          editFormBaselines: { ...(prior?.editFormBaselines ?? {}) },
          ...(prior?.subject === undefined ? {} : { subject: prior.subject }),
        };
      });
      void refreshPlacements([parsedId.data]);
    }
    return false;
  };

  try {
    let result: Awaited<ReturnType<typeof rereadApplicationPlacements>>;
    try {
      result = await rereadApplicationPlacements(
        {
          tenantShortName: application.tenantShortName,
          organizationShortName: application.organizationShortName,
          applicationKey: application.applicationKey,
          pageKey: currentPageKey,
          installationRevision: application.installationRevision,
          search: currentSearch,
        },
        [parsedId.data],
        [{ placementId: parsedId.data, request: columnRead.data }],
      );
    } catch {
      result = { kind: "temporarily_unavailable" };
    }
    if (
      placementRequestsRef.current.key !== requestScope.key ||
      !isCurrentComponentRequestGeneration(
        requestScope.generations.get(parsedId.data.toLowerCase()),
        request,
      )
    )
      return false;
    if (result.kind === "reload") {
      router.refresh();
      return false;
    }
    if (result.kind !== "available") return clearAndReload();

    const returnedData = Object.entries(result.data).find(
      ([candidate]) => candidate.toLowerCase() === parsedId.data.toLowerCase(),
    )?.[1];
    const freshBoard = boardPayloadFor(returnedData);
    const mergedBoard =
      freshBoard === undefined
        ? undefined
        : mergeBoardColumnRead(currentBoard, freshBoard, columnRead.data);
    if (mergedBoard === undefined) return clearAndReload();

    setRefreshedPlacementData((current) => {
      const liveScope = placementRequestsRef.current;
      if (
        liveScope.key !== requestScope.key ||
        !isCurrentComponentRequestGeneration(
          liveScope.generations.get(parsedId.data.toLowerCase()),
          request,
        )
      )
        return current;
      const prior = current?.navigationKey === requestScope.key ? current : undefined;
      return {
        navigationKey: requestScope.key,
        data: {
          ...(prior?.data ?? {}),
          [displayId]: { status: "ready", values: mergedBoard },
        },
        editFormBaselines: { ...(prior?.editFormBaselines ?? {}) },
        ...(prior?.subject === undefined ? {} : { subject: prior.subject }),
      };
    });
    return true;
  } finally {
    boardContinuationInFlightRef.current.delete(serialKey);
  }
}
