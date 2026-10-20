import {
  ATTACHMENT_LIST_BLOCK_RELEASE,
  isStreamableQueryPlacement,
  logPlacementFailure,
  projectReferenceChoiceInputValues,
  readQueryPlacement,
  type createReferenceChoiceService,
  type HumanOrganizationRequestDependencies,
  type PageSubjectReadResult,
  type PlacementReadInput,
} from "@vortex/platform/server";
import { isRecord, sameId } from "@vortex/platform/schema";
import { hasReferenceChoiceSource, projectedReferenceChoiceForm } from "../reference-choices";
import type { collectPlacements } from "./placement-helpers";
import type { ApplicationPageModel } from "./types";
import { readAttachmentListPlacement } from "./attachment-placement";

/**
 * One page's placement read on the web: the platform's read of every query-bound block plus the two
 * placements whose data is the web page's own concern, a reference-choice field's first page of
 * choices and an attachment list.
 */
export type PlacementReaderInput = PlacementReadInput &
  Readonly<{
    page: Parameters<typeof collectPlacements>[0];
    pageSubjectRecordTypeId: string | undefined;
    referenceChoiceInputs: Array<ApplicationPageModel["referenceChoiceInputs"][number]>;
    referenceChoices: ReturnType<typeof createReferenceChoiceService>;
    dependencies: HumanOrganizationRequestDependencies;
    adoptSubjectRead: (subject: PageSubjectReadResult) => void;
  }>;

/**
 * Whether a placement's data comes only from its own bound query, so the page may stream it after
 * the frame (a reference-choice field never streams: its form waits for its choices).
 */
export const isStreamablePlacement = (
  placement: ReturnType<typeof collectPlacements>[number],
): boolean => !hasReferenceChoiceSource(placement) && isStreamableQueryPlacement(placement);

const readReferenceChoices = async (
  input: PlacementReaderInput,
  placement: ReturnType<typeof collectPlacements>[number],
): Promise<void> => {
  const { placementId, formId } = placement;
  const { data } = input;
  const form =
    formId === undefined
      ? undefined
      : projectedReferenceChoiceForm(input.page, input.context.releaseSet.modules, formId);
  const field = form?.placements.get(placementId);
  if (field === undefined || formId === undefined) {
    logPlacementFailure(input.address, placementId, "choice_settings_invalid");
    data[placementId] = { status: "disabled", reason: "Choices unavailable" };
    return;
  }
  const parent =
    field.dependency === undefined
      ? undefined
      : [...(form?.placements ?? [])].find(
          ([, candidate]) => candidate.fieldKey === field.dependency?.fromField,
        );
  input.referenceChoiceInputs.push({
    placementId,
    formId,
    fieldKey: field.fieldKey,
    ...(parent === undefined
      ? {}
      : { dependency: { fieldKey: parent[1].fieldKey, placementId: parent[0] } }),
  });
  if (field.dependency !== undefined) {
    data[placementId] = {
      status: "ready",
      values: projectReferenceChoiceInputValues([], null, undefined, { dependencyKey: null }),
    };
    return;
  }
  const result = await input.referenceChoices.run(input.session, input.selection, field.command);
  if (
    result.kind !== "available" ||
    result.value.outcome !== "completed" ||
    result.value.kind !== "record_reference"
  ) {
    data[placementId] = { status: "disabled", reason: "Choices unavailable" };
    return;
  }
  data[placementId] = {
    status: "ready",
    values: projectReferenceChoiceInputValues(
      result.value.choices,
      undefined,
      undefined,
      result.value.nextContinuationToken === undefined
        ? {}
        : { nextContinuationToken: result.value.nextContinuationToken },
    ),
  };
};

export const readPlacement = async (
  input: PlacementReaderInput,
  placement: ReturnType<typeof collectPlacements>[number],
): Promise<void> => {
  if (hasReferenceChoiceSource(placement)) {
    await readReferenceChoices(input, placement);
    return;
  }
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
