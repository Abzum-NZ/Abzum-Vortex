import { logRefusal, sameId, splitProjectedPage } from "@vortex/platform/schema";
import "server-only";

import {
  createReferenceChoiceService,
  projectReferenceChoiceInputValues,
} from "@vortex/platform/server";
import type {
  IdentitySession,
  ReferenceChoiceSelectionEvidence,
  JsonValue,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "./query-continuation-key";
import {
  type ProjectedReferenceChoiceForm,
  projectedReferenceChoiceForm,
  resolveReferenceChoiceOption,
} from "./reference-choices";
import {
  type ReferenceChoiceAddress,
  projectReferenceChoicePage,
  type ReferenceChoicePageResult,
} from "./application-page/reference-choice";
import { collectPlacements } from "./application-page/placement-helpers";
import type {
  ApplicationPageLoaderAddress,
  SearchParameters,
  ApplicationPageResult,
  BoardReadTarget,
  TableContinuationTarget,
  ApplicationPagePlacementReadResult,
  PageDataState,
  PageLoadOptions,
} from "./application-page/types";
import { loadApplicationPageInternal } from "./application-page/load";

/**
 * Composes the one server model of an installed application page: the permission-filtered page,
 * the viewer's menu, the theme and the persisted data every data placement reads. Everything comes
 * from the verified human request and the exact installed release; the browser supplies only the
 * address and the page's own query string. Nothing here decides permission: the stored page and
 * navigation services, the Query engine and the flow endpoint each keep their own Access decision.
 */

export type {
  PageDataState,
  PlacementFlowBinding,
  ApplicationPageModel,
  ApplicationPagePlacementReadResult,
  PageWebMcpTool,
} from "./application-page/types";

/** The form submission's fields come only from its current actor-permitted page. */
export const loadProjectedReferenceChoiceForm = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{
    installationRevision: number;
    releaseKey: string;
    formId: string;
    subjectRecordId?: string;
  }>,
): Promise<ProjectedReferenceChoiceForm | undefined> => {
  try {
    const projected = await projectReferenceChoicePage(session, address, request);
    return projected.kind === "available"
      ? projectedReferenceChoiceForm(
          projected.page,
          projected.context.releaseSet.modules,
          request.formId,
        )
      : undefined;
  } catch (cause) {
    logRefusal("reference-choices", "project form", "reference_choice_form_unavailable", cause);
    return undefined;
  }
};

/** Rechecks one dynamic choice request against the viewer's current installed page and authority. */
export const loadReferenceChoicePage = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{
    placementId: string;
    installationRevision: number;
    releaseKey: string;
    search?: string;
    continuationToken?: string;
    selectedKey?: string;
    selectedEvidence?: ReferenceChoiceSelectionEvidence;
  }>,
): Promise<ReferenceChoicePageResult> => {
  try {
    const projected = await projectReferenceChoicePage(session, address, request);
    if (projected.kind !== "available") return projected;
    const { dependencies, selection, context } = projected;
    const continuationKey = getQueryContinuationKey();
    const placement = collectPlacements(projected.page).find(
      (entry) => entry.placementId === request.placementId && entry.formId !== undefined,
    );
    if (placement === undefined || placement.formId === undefined) return { kind: "refused" };
    const form = projectedReferenceChoiceForm(
      projected.page,
      context.releaseSet.modules,
      placement.formId,
    );
    const field = form?.placements.get(request.placementId);
    if (field === undefined || form === undefined) return { kind: "refused" };

    const service = createReferenceChoiceService({ ...dependencies, continuationKey });
    const currentField = field;
    const result = await service.run(session, selection, {
      ...currentField.command,
      ...(request.search === undefined || request.search.trim() === ""
        ? {}
        : { search: request.search }),
      ...(request.continuationToken === undefined
        ? {}
        : { continuationToken: request.continuationToken }),
    });
    if (result.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (result.kind !== "available" || result.value.outcome !== "completed")
      return { kind: "refused" };

    const pageChoices = result.value.choices;
    let selectedChoice =
      request.selectedKey === undefined
        ? undefined
        : pageChoices.find((choice) => choice.key === request.selectedKey);
    let selectedEvidenceOverride: Readonly<Record<string, ReferenceChoiceSelectionEvidence>> = {};
    if (
      selectedChoice === undefined &&
      request.selectedKey !== undefined &&
      request.selectedEvidence !== undefined
    ) {
      selectedChoice = await resolveReferenceChoiceOption({
        service,
        session,
        selection,
        field: currentField,
        key: request.selectedKey,
        evidence: request.selectedEvidence,
      });
      if (selectedChoice !== undefined)
        selectedEvidenceOverride = { [selectedChoice.key]: request.selectedEvidence };
    }
    const choices =
      selectedChoice === undefined ||
      pageChoices.some((choice) => choice.key === selectedChoice?.key)
        ? pageChoices
        : [selectedChoice, ...pageChoices];
    return {
      kind: "completed",
      values: projectReferenceChoiceInputValues(choices, selectedChoice?.key ?? null, undefined, {
        ...(request.search === undefined ? {} : { search: request.search }),
        ...(request.continuationToken === undefined
          ? {}
          : { continuationToken: request.continuationToken }),
        ...(result.value.nextContinuationToken === undefined
          ? {}
          : { nextContinuationToken: result.value.nextContinuationToken }),
        ...(Object.keys(selectedEvidenceOverride).length === 0
          ? {}
          : { optionEvidenceOverrides: selectedEvidenceOverride }),
      }),
    };
  } catch (cause) {
    logRefusal("reference-choices", "choice page", "reference_choice_page_unavailable", cause);
    return { kind: "temporarily_unavailable" };
  }
};

export const loadApplicationPage = (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  options?: PageLoadOptions,
): Promise<ApplicationPageResult> =>
  loadApplicationPageInternal(
    session,
    address,
    parameters,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  ).then((result) => {
    if (result.kind === "placements") throw new Error("PLACEMENT_READ_FOR_WHOLE_PAGE");
    return result.kind === "reload" ? { kind: "unavailable" } : result;
  });

/** Loads only the requested placements through the same protected page, Query and Record reads. */
export const loadApplicationPagePlacements = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  placementIds: readonly string[],
  expectedInstallationRevision: number,
  boardReads?: readonly BoardReadTarget[],
  tableContinuation?: TableContinuationTarget,
  includeContent?: boolean,
): Promise<ApplicationPagePlacementReadResult> => {
  const requestedIds = new Set(placementIds.map((placementId) => placementId.toLowerCase()));
  if (
    boardReads?.some(
      (read) => !placementIds.some((placementId) => sameId(placementId, read.placementId)),
    ) === true ||
    (tableContinuation !== undefined &&
      (placementIds.length !== 1 || !sameId(placementIds[0] ?? "", tableContinuation.placementId)))
  )
    return { kind: "unavailable" };
  const loaded = await loadApplicationPageInternal(
    session,
    address,
    parameters,
    requestedIds,
    boardReads,
    expectedInstallationRevision,
    tableContinuation,
  );
  if (loaded.kind === "reload") return loaded;
  // The page itself names why a draft that cannot run does not open; its parts are unavailable.
  if (loaded.kind === "not_runnable") return { kind: "unavailable" };
  if (loaded.kind !== "placements") {
    if (loaded.kind === "available") throw new Error("WHOLE_PAGE_READ_FOR_PLACEMENTS");
    return loaded;
  }

  const loadedData = Object.entries(loaded.model.data);
  const loadedBaselines = Object.entries(loaded.model.editFormBaselines);
  const data: Record<string, PageDataState> = {};
  const editFormBaselines: Record<string, Readonly<Record<string, JsonValue>> | null> = {};
  for (const placementId of requestedIds) {
    const entry = loadedData.find(([candidate]) => sameId(candidate, placementId));
    const displayId = entry?.[0] ?? placementId;
    const baseline = loadedBaselines.find(([candidate]) => sameId(candidate, placementId));
    data[displayId] = entry?.[1] ?? { status: "error" };
    editFormBaselines[displayId] = baseline?.[1] ?? null;
  }
  return {
    kind: "available",
    data,
    editFormBaselines,
    subject: loaded.model.subject ?? null,
    // The same projection the page load decided, so a control's availability is never decided twice.
    ...(includeContent === true
      ? {
          content: splitProjectedPage(loaded.model.page, loaded.applicationShell).content,
        }
      : {}),
  };
};
