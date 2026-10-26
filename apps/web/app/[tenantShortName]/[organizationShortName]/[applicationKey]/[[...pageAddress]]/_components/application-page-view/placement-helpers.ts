import {
  parseBoardPayload,
  parseTablePayload,
  type createPlatformComponentRegistryForReleases,
  type BoardPayload,
} from "@vortex/ui";
import {
  type BoardColumnReadRequest,
  type BoardColumnSelector,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  isRecord,
  walkPageComposition,
  walkPlacementData,
} from "@vortex/platform/schema";
import { isPlatformRelease } from "./form-surface";

/** Finds the semantic events each registered placement declares in the rendered page tree. */
export const placementEventNamesByPage = (
  page: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
): Readonly<Record<string, ReadonlySet<string>>> => {
  const eventNames: Record<string, ReadonlySet<string>> = {};
  walkPageComposition(page.composition, ({ placementId, vortex }) => {
    const block = vortex.block;
    if (
      isRecord(block) &&
      typeof block.blockId === "string" &&
      typeof block.releaseVersion === "string"
    ) {
      const registration = registry.get(block.blockId, block.releaseVersion);
      if (registration !== undefined)
        eventNames[placementId] = new Set(registration.metadata.supportedEvents);
    }
    return undefined;
  });
  return eventNames;
};

/** Finds launcher placements whose row actions open through the addressed server action. */
export const applicationLauncherPlacementIds = (
  page: Readonly<Record<string, unknown>>,
  registry: ReturnType<typeof createPlatformComponentRegistryForReleases>,
): Set<string> => {
  const placementIds = new Set<string>();
  walkPageComposition(page.composition, ({ placementId, vortex }) => {
    if (
      isPlatformRelease(
        registry,
        vortex.block,
        PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_LAUNCHER_BLOCK_RELEASE,
      )
    )
      placementIds.add(placementId);
    return undefined;
  });
  return placementIds;
};

/** Every placement identity of one projected layout (a page's or one guided step's). */
export const placementIdsInLayout = (candidate: unknown): ReadonlySet<string> => {
  const result = new Set<string>();
  walkPlacementData(candidate, ({ placementId }) => {
    result.add(placementId);
    return undefined;
  });
  return result;
};

export const boardPayloadFor = (candidate: unknown): BoardPayload | undefined => {
  if (
    !isRecord(candidate) ||
    candidate.status !== "ready" ||
    !isRecord(candidate.values) ||
    candidate.values.kind !== "board"
  )
    return undefined;
  try {
    return parseBoardPayload(candidate.values);
  } catch (error) {
    // The server built this board payload; a parse failure is a defect, so the cause stays visible.
    console.error("[page] BOARD_PAYLOAD_INVALID", error);
    return undefined;
  }
};

export const tablePayloadFor = (
  candidate: unknown,
): ReturnType<typeof parseTablePayload> | undefined => {
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
  left.cardFieldIds.every(
    (fieldId, index) => fieldId.toLowerCase() === right.cardFieldIds[index]?.toLowerCase(),
  );

export const boardBucketForSelector = (
  board: BoardPayload,
  selector: BoardColumnSelector,
): BoardPayload["unassigned"] | BoardPayload["columns"][number] | undefined =>
  selector.kind === "unassigned"
    ? board.unassigned
    : board.columns.find((column) => column.value === selector.value);

/** The columns of a board whose cards have been read: the set a refresh reads again. */
export const loadedBoardColumns = (board: BoardPayload): readonly BoardColumnSelector[] => [
  ...board.columns.flatMap((column) =>
    column.page === null ? [] : [{ kind: "option" as const, value: column.value }],
  ),
  ...(board.unassigned.page === null ? [] : [{ kind: "unassigned" as const }]),
];

/**
 * The displayed board with the pages one column read returned: every named column takes its fresh
 * page, every other column keeps what it showed, and counts and totals come from the fresh summary.
 */
export const mergeBoardColumnRead = (
  current: BoardPayload,
  fresh: BoardPayload,
  request: BoardColumnReadRequest,
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
  const named = (selector: BoardColumnSelector): boolean =>
    request.columns.some(
      (candidate) =>
        candidate.kind === selector.kind &&
        (candidate.kind === "unassigned" ||
          (selector.kind === "option" && candidate.value === selector.value)),
    );
  for (const selector of request.columns) {
    const currentBucket = boardBucketForSelector(current, selector);
    const freshBucket = boardBucketForSelector(fresh, selector);
    if (
      currentBucket === undefined ||
      freshBucket?.page === undefined ||
      freshBucket.page === null ||
      (request.continuationToken !== undefined &&
        currentBucket.page?.nextContinuationToken !== request.continuationToken)
    )
      return undefined;
  }
  const columns = fresh.columns.map((column, index) =>
    named({ kind: "option", value: column.value }) ? column : current.columns[index]!,
  );
  const unassigned = named({ kind: "unassigned" }) ? fresh.unassigned : current.unassigned;
  try {
    return parseBoardPayload({ ...fresh, columns, unassigned });
  } catch (error) {
    console.error("[board] merged column payload invalid", error);
    // A duplicate live record identity or strict merged-shape mismatch triggers a fresh read.
    return undefined;
  }
};
