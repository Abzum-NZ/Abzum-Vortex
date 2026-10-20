import "server-only";

import {
  pageQueryBindingContext,
  readRecordsTablePivot,
  type PivotResult,
} from "@vortex/platform/server";
import {
  describeFailure,
  recordIdSchema,
  sameId,
  type OrganizationSelectionCandidate,
  type IdentitySession,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "../query-continuation-key";
import { loadInstalledContext, readPageProjections, requestDependencies } from "./load";
import {
  collectPlacements,
  first,
  isTablePlacement,
  pageSubjectParameter,
  projectedUseAvailability,
} from "./placement-helpers";
import { createPlacementReadServices } from "./placement-services";
import type { ApplicationPageLoaderAddress, SearchParameters } from "./types";

export type PivotLoadResult =
  | Readonly<{ kind: "available"; pivot: PivotResult }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * Reads one page of a table's pivot on the viewer's current page. The page is projected again for
 * this viewer, so the Records table must still be on it and usable; the pivot's dimensions, measure
 * and caps are decided on the server by the platform's pivot read from the installed placement, and
 * the table's own search and filters come from the page address through the table state codec. The
 * browser supplies the page address, the table's placement and the opaque row position.
 */
export const loadApplicationPivot = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  request: Readonly<{
    placementId: string;
    cursor?: string;
    installationRevision: number;
  }>,
): Promise<PivotLoadResult> => {
  const dependencies = requestDependencies();
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
    ...(address.application.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: address.application.previewInstallationId }),
  };
  const carried = address.installedContext;
  const loaded =
    carried !== undefined &&
    sameId(carried.organizationId, selection.organizationId) &&
    sameId(carried.applicationRootId, address.application.applicationRootId)
      ? ({ kind: "available", value: carried } as const)
      : await loadInstalledContext(session, dependencies, selection);
  if (loaded.kind !== "available") return loaded;
  const context = loaded.value;
  if (context.applicationReleaseRevision !== request.installationRevision)
    return { kind: "reload" };
  const pageDefinition = context.releaseSet.application.content.pages.find(
    (page) => page.key === address.pageKey,
  );
  if (pageDefinition === undefined) return { kind: "unavailable" };

  const subjectId = first(parameters[pageSubjectParameter]);
  const { projectedPageRead, navigationRead } = readPageProjections(
    session,
    context,
    pageDefinition.pageId,
    subjectId,
  );
  try {
    const projectedPage = await projectedPageRead;
    if (projectedPage.kind !== "available") return projectedPage;
    if (projectedPage.value === undefined) return { kind: "unavailable" };
    // The table must be on the page as projected for this viewer now, once, and usable.
    const targets = collectPlacements(projectedPage.value).filter(({ placementId }) =>
      sameId(placementId, request.placementId),
    );
    const placement = targets[0];
    if (
      placement === undefined ||
      targets.length !== 1 ||
      !isTablePlacement(placement) ||
      projectedUseAvailability(placement) !== "available"
    )
      return { kind: "unavailable" };

    const services = createPlacementReadServices({
      session,
      selection,
      dependencies,
      continuationKey: getQueryContinuationKey(),
      tenantShortName: address.tenantShortName,
      organizationShortName: address.organizationShortName,
    });
    const subjectType =
      (pageDefinition.type === "detail" ||
        pageDefinition.type === "public" ||
        pageDefinition.type === "form" ||
        pageDefinition.type === "guided_form") &&
      pageDefinition.recordType?.state === "resolved"
        ? pageDefinition.recordType
        : undefined;
    const subjectRecordId = recordIdSchema.safeParse(subjectId);
    const readTimeZone = async (): Promise<string | undefined> => {
      try {
        const read = await services.readCalendarSettings();
        return read.kind === "available" ? read.value.settings?.timeZone : undefined;
      } catch (error) {
        console.error(`[page] organisation time zone unavailable: ${describeFailure(error)}`);
        return undefined;
      }
    };
    const bindings = pageQueryBindingContext({
      context,
      pageDefinition,
      parameters,
      readSubject:
        subjectType === undefined
          ? undefined
          : () =>
              subjectRecordId.success
                ? services.subjects.read(session, selection, {
                    recordTypeId: String(subjectType.recordTypeId),
                    recordId: subjectRecordId.data,
                  })
                : Promise.resolve({ kind: "refused" }),
      subjectRecordTypeId: subjectType === undefined ? undefined : String(subjectType.recordTypeId),
      readTimeZone,
    });
    const pivot = await readRecordsTablePivot({
      context,
      session,
      selection,
      placement,
      addressEntries: Object.entries(parameters).flatMap(([name, value]) =>
        (typeof value === "string" ? [value] : (value ?? [])).map((text): [string, string] => [
          name,
          text,
        ]),
      ),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      bindings,
      queries: services.queries,
      readTimeZone,
    });
    return { kind: "available", pivot };
  } finally {
    await Promise.allSettled([projectedPageRead, navigationRead]);
  }
};
