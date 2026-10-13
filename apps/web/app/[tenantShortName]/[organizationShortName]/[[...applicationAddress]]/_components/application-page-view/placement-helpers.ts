import {
  parseBoardPayload,
  parseTablePayload,
  type createFullPlatformComponentRegistry,
  type BoardPayload,
} from "@vortex/ui";
import {
  type BoardColumnSelector,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
} from "@vortex/platform/schema";
import type { PlacementFlowBinding } from "../../../../../_lib/application-page";
import { isRecord } from "./event-values";
import { isPlatformRelease } from "./form-surface";

/** Finds the semantic events each registered placement declares in the rendered page tree. */
export const placementEventNamesByPage = (
  page: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createFullPlatformComponentRegistry>,
): Readonly<Record<string, ReadonlySet<string>>> => {
  const eventNames: Record<string, ReadonlySet<string>> = {};
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const block = candidate.block;
      if (
        isRecord(block) &&
        typeof block.blockId === "string" &&
        typeof block.releaseVersion === "string"
      ) {
        const registration = registry.get(block.blockId, block.releaseVersion);
        if (registration !== undefined)
          eventNames[placementId] = new Set(registration.metadata.supportedEvents);
      }
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child);
    }
  };
  const composition = page.composition;
  if (!isRecord(composition)) return eventNames;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const child of Object.values(composition.stepContent)) visit(child);
  return eventNames;
};

/** Finds launcher placements whose row actions open through the addressed server action. */
export const applicationLauncherPlacementIds = (
  page: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createFullPlatformComponentRegistry>,
): Set<string> => {
  const placementIds = new Set<string>();
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const block = candidate.block;
      if (isPlatformRelease(registry, block, PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_LAUNCHER_BLOCK_RELEASE))
        placementIds.add(placementId);
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child);
    }
  };
  const composition = page.composition;
  if (!isRecord(composition)) return placementIds;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const child of Object.values(composition.stepContent)) visit(child);
  return placementIds;
};

export const placementIdsInSlot = (candidate: unknown): ReadonlySet<string> => {
  const result = new Set<string>();
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, placement] of Object.entries(slot.placements)) {
      result.add(placementId);
      if (isRecord(placement) && isRecord(placement.slots))
        for (const child of Object.values(placement.slots)) visit(child);
    }
  };
  visit(candidate);
  return result;
};

export const boardPayloadFor = (candidate: unknown): BoardPayload | undefined => {
  if (!isRecord(candidate) || candidate.status !== "ready") return undefined;
  try {
    return parseBoardPayload(candidate.values);
  } catch {
    return undefined;
  }
};

export const tablePayloadFor = (candidate: unknown): ReturnType<typeof parseTablePayload> | undefined => {
  if (!isRecord(candidate) || candidate.status !== "ready") return undefined;
  if (!isRecord(candidate.values) || candidate.values.kind !== "table") return undefined;
  try {
    return parseTablePayload(candidate.values);
  } catch (error) {
    console.error("[page] table payload invalid", error);
    return undefined;
  }
};

const sameBoardSource = (left: BoardPayload, right: BoardPayload): boolean =>
  left.plan.moduleRootId.toLowerCase() === right.plan.moduleRootId.toLowerCase() &&
  left.plan.moduleReleaseVersion === right.plan.moduleReleaseVersion &&
  left.plan.queryId.toLowerCase() === right.plan.queryId.toLowerCase() &&
  left.choiceFieldId.toLowerCase() === right.choiceFieldId.toLowerCase() &&
  left.cardTitleFieldId.toLowerCase() === right.cardTitleFieldId.toLowerCase() &&
  left.cardFieldIds.length === right.cardFieldIds.length &&
  left.cardFieldIds.every((fieldId, index) =>
    fieldId.toLowerCase() === right.cardFieldIds[index]?.toLowerCase(),
  );

export const boardBucketForSelector = (
  board: BoardPayload,
  selector: BoardColumnSelector,
): BoardPayload["unassigned"] | BoardPayload["columns"][number] | undefined =>
  selector.kind === "unassigned"
    ? board.unassigned
    : board.columns.find((column) => column.value === selector.value);

export const mergeBoardContinuation = (
  current: BoardPayload,
  fresh: BoardPayload,
  selector: BoardColumnSelector,
): BoardPayload | undefined => {
  if (
    !sameBoardSource(current, fresh) ||
    current.columns.length !== fresh.columns.length ||
    current.columns.some(
      (column, index) =>
        column.value !== fresh.columns[index]?.value ||
        column.label !== fresh.columns[index]?.label,
    )
  )
    return undefined;
  const selectedCurrent = boardBucketForSelector(current, selector);
  const selectedFresh = boardBucketForSelector(fresh, selector);
  if (
    selectedCurrent?.page?.nextContinuationToken === undefined ||
    selectedFresh?.page === undefined ||
    selectedFresh.page === null
  )
    return undefined;
  const columns = fresh.columns.map((column, index) => ({
    ...column,
    page:
      selector.kind === "option" && column.value === selector.value
        ? column.page
        : (current.columns[index]?.page ?? null),
  }));
  const unassigned = {
    ...fresh.unassigned,
    page: selector.kind === "unassigned" ? fresh.unassigned.page : current.unassigned.page,
  };
  try {
    return parseBoardPayload({ ...fresh, columns, unassigned });
  } catch {
    // A duplicate live record identity or strict merged-shape mismatch triggers an initial reread.
    return undefined;
  }
};

export const compatibleBoardRowAction = (
  bindings: readonly PlacementFlowBinding[],
): PlacementFlowBinding | undefined => {
  const rowActions = bindings.filter((binding) => binding.event === "row_action");
  if (rowActions.length !== 1) return undefined;
  const [binding] = rowActions;
  if (binding?.recordTypeId === undefined) return undefined;
  const canReceiveSelectedRecord = binding.callerInputs.some(
    (inputName) =>
      inputName === "record_id" ||
      (binding.selectedReadInputs ?? []).some(
        (selected) =>
          selected.callerInputName === inputName &&
          selected.recordTypeId.toLowerCase() === binding.recordTypeId?.toLowerCase(),
      ),
  );
  return canReceiveSelectedRecord ? binding : undefined;
};
