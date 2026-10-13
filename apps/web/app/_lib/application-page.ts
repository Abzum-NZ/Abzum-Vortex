import "server-only";

import {
  createReferenceChoiceService,
  projectReferenceChoiceInputValues,
} from "@web/platform-server";
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
  bindReferenceChoiceField,
} from "./reference-choices";
import {
  type ReferenceChoiceAddress,
  projectReferenceChoicePage,
  type ReferenceChoicePageResult,
} from "./application-page/reference-choice";
import { collectPlacements, sameId } from "./application-page/placement-helpers";
import type {
  ApplicationPageLoaderAddress,
  SearchParameters,
  ApplicationPageResult,
  BoardContinuationTarget,
  TableContinuationTarget,
  ApplicationPagePlacementReadResult,
  PageDataState,
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
} from "./application-page/types";

/** The form submission's fields come only from its current actor-permitted page. */
export const loadProjectedReferenceChoiceForm = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{ installationRevision: number; releaseKey: string; formId: string }>,
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
  } catch {
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
    dependencyChoice?: Readonly<{ key: string; evidence: ReferenceChoiceSelectionEvidence }>;
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
    if (placement === undefined || placement.formId === undefined)
      return { kind: "refused" };
    const form = projectedReferenceChoiceForm(
      projected.page,
      context.releaseSet.modules,
      placement.formId,
    );
    const field = form?.placements.get(request.placementId);
    if (field === undefined || form === undefined) return { kind: "refused" };

    const service = createReferenceChoiceService({ ...dependencies, continuationKey });
    let currentField = field;
    let dependencyKey: string | null | undefined;
    if (field.dependency !== undefined) {
      if (request.dependencyChoice === undefined)
        return {
          kind: "completed",
          values: projectReferenceChoiceInputValues([], null, undefined, { dependencyKey: null }),
        };
      const parent = form.fields.get(field.dependency.fromField);
      if (parent === undefined) return { kind: "refused" };
      const selected = await resolveReferenceChoiceOption({
        service, session, selection, field: parent,
        key: request.dependencyChoice.key,
        evidence: request.dependencyChoice.evidence,
      });
      if (selected === undefined) return { kind: "refused" };
      const bound = bindReferenceChoiceField(form.fields, field, selected);
      if (bound === undefined) return { kind: "refused" };
      currentField = bound;
      dependencyKey = selected.key;
    } else if (request.dependencyChoice !== undefined) return { kind: "refused" };
    const result = await service.run(session, selection, {
      ...currentField.command,
      ...(request.search === undefined || request.search.trim() === ""
        ? {}
        : { search: request.search }),
      ...(request.continuationToken === undefined
        ? {}
        : { continuationToken: request.continuationToken }),
    });
    if (result.kind === "temporarily_unavailable")
      return { kind: "temporarily_unavailable" };
    if (result.kind !== "available" || result.value.outcome !== "completed")
      return { kind: "refused" };

    const pageChoices = result.value.choices;
    let selectedChoice = request.selectedKey === undefined
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
      selectedChoice === undefined || pageChoices.some((choice) => choice.key === selectedChoice?.key)
        ? pageChoices
        : [selectedChoice, ...pageChoices];
    return {
      kind: "completed",
      values: projectReferenceChoiceInputValues(
        choices,
        selectedChoice?.key ?? null,
        undefined,
        {
          ...(dependencyKey === undefined ? {} : { dependencyKey }),
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
        },
      ),
    };
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

export const loadApplicationPage = (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
): Promise<ApplicationPageResult> =>
  loadApplicationPageInternal(session, address, parameters).then((result) =>
    result.kind === "reload" ? { kind: "unavailable" } : result,
  );

/** Loads only the requested placements through the same protected page, Query and Record reads. */
export const loadApplicationPagePlacements = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  placementIds: readonly string[],
  expectedInstallationRevision: number,
  boardContinuation?: BoardContinuationTarget,
  tableContinuation?: TableContinuationTarget,
): Promise<ApplicationPagePlacementReadResult> => {
  const requestedIds = new Set(placementIds.map((placementId) => placementId.toLowerCase()));
  if (
    (boardContinuation !== undefined || tableContinuation !== undefined) &&
    (placementIds.length !== 1 ||
      (boardContinuation !== undefined &&
        !sameId(placementIds[0] ?? "", boardContinuation.placementId)) ||
      (tableContinuation !== undefined &&
        !sameId(placementIds[0] ?? "", tableContinuation.placementId)))
  )
    return { kind: "unavailable" };
  const loaded = await loadApplicationPageInternal(
    session,
    address,
    parameters,
    requestedIds,
    boardContinuation,
    expectedInstallationRevision,
    tableContinuation,
  );
  if (loaded.kind === "reload") return loaded;
  if (loaded.kind !== "available") return loaded;

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
  return { kind: "available", data, editFormBaselines, subject: loaded.model.subject ?? null };
};
