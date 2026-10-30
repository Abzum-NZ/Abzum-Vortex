import { logRefusal, sameId, splitProjectedPage } from "@vortex/platform/schema";
import "server-only";

import type { BoundHumanOrganizationRequest } from "@vortex/platform/server";
import type { IdentitySession, JsonValue } from "@vortex/platform/schema";
import {
  type OptionsAddress,
  type ProjectedOptionsForm,
  projectOptionsPage,
  projectedOptionsForm,
} from "./application-page/options-projection";
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
export const loadProjectedOptionsForm = async (
  session: IdentitySession,
  address: OptionsAddress,
  request: Readonly<{
    installationRevision: number;
    releaseKey: string;
    formId: string;
    subjectRecordId?: string;
  }>,
  bound?: BoundHumanOrganizationRequest,
): Promise<
  | (ProjectedOptionsForm & Readonly<{ projectedPage?: Readonly<Record<string, unknown>> }>)
  | undefined
> => {
  try {
    const projected = await projectOptionsPage(session, address, request, bound);
    if (projected.kind !== "available") return undefined;
    const form = projectedOptionsForm(projected.page, request.formId);
    return form === undefined
      ? undefined
      : { ...form, ...(bound === undefined ? {} : { projectedPage: projected.rawPage }) };
  } catch (cause) {
    logRefusal("field-options", "project form", "options_form_unavailable", cause);
    return undefined;
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
