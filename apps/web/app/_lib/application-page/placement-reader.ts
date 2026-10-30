import {
  ATTACHMENT_LIST_BLOCK_RELEASE,
  isStreamableQueryPlacement,
  readQueryPlacement,
  type HumanOrganizationRequestDependencies,
  type PageSubjectReadResult,
  type PlacementReadInput,
} from "@vortex/platform/server";
import { isRecord, sameId } from "@vortex/platform/schema";
import type { collectPlacements } from "./placement-helpers";
import { readAttachmentListPlacement } from "./attachment-placement";

/**
 * One page's placement read on the web: the platform's read of every query-bound block plus the two
 * placement whose data is the web page's own concern, an attachment list.
 */
export type PlacementReaderInput = PlacementReadInput &
  Readonly<{
    page: Parameters<typeof collectPlacements>[0];
    pageSubjectRecordTypeId: string | undefined;
    dependencies: HumanOrganizationRequestDependencies;
    adoptSubjectRead: (subject: PageSubjectReadResult) => void;
  }>;

/**
 * Whether a placement's data comes only from its own bound query, so the page may stream it after
 * the frame.
 */
export const isStreamablePlacement = (
  placement: ReturnType<typeof collectPlacements>[number],
): boolean => isStreamableQueryPlacement(placement);

export const readPlacement = async (
  input: PlacementReaderInput,
  placement: ReturnType<typeof collectPlacements>[number],
): Promise<void> => {
  const block = placement.vortex.block;
  if (
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, ATTACHMENT_LIST_BLOCK_RELEASE.blockId)
  ) {
    await readAttachmentListPlacement({
      block,
      placement,
      pageDefinition: input.pageDefinition,
      subjectType: input.subjectType,
      pageSubjectRecordTypeId: input.pageSubjectRecordTypeId,
      data: input.data,
      placementId: placement.placementId,
      settings: placement.settings as Parameters<typeof readAttachmentListPlacement>[0]["settings"],
      context: input.context,
      parameters: input.parameters,
      dependencies: input.dependencies,
      session: input.session,
      selection: input.selection,
      page: input.page,
      adoptSubjectRead: input.adoptSubjectRead,
    });
    return;
  }
  await readQueryPlacement(input, placement);
};
