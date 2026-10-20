import "server-only";

import {
  pageQueryBindingContext,
  readRecordsTableRowDetail,
  isTreeTablePlacement,
  readRecordsTableTreeLevel,
  resolvedQueryRecordTypeId,
  type PlacementReadInput,
  type RowDetailResult,
  type TreeLevelResult,
} from "@vortex/platform/server";
import {
  applicationLauncherQueryRowsToListValues,
  parseBoardPayload,
  parseDisplayData,
} from "@vortex/ui";
import {
  describeFailure,
  recordIdSchema,
  sameId,
  type OrganizationSelectionCandidate,
  type IdentitySession,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "../query-continuation-key";
import { loadInstalledContext, readPageProjections, requestDependencies } from "./load";
import { pageGridLayoutRequest, readPageGridLayouts } from "./grid-layouts";
import {
  collectPlacements,
  first,
  isTablePlacement,
  pageSubjectParameter,
  projectedUseAvailability,
} from "./placement-helpers";
import { createPlacementReadServices } from "./placement-services";
import type { ApplicationPageLoaderAddress, SearchParameters } from "./types";

export type RowDetailLoadResult =
  | Readonly<{ kind: "available"; detail: RowDetailResult | TreeLevelResult }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * Reads one expanded row's related records on the viewer's current page. The page is projected
 * again for this viewer, so the Records table must still be on it and usable; the row, the related
 * records query and its inputs are all decided on the server by the platform's row detail read.
 * The browser supplies the page address, the table's placement, the row's record identity and a
 * continuation token the Query engine sealed for this same read.
 */
export const loadApplicationRowDetail = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  request: Readonly<{
    placementId: string;
    recordId: string;
    continuationToken?: string;
    pageSize?: number;
    installationRevision: number;
  }>,
): Promise<RowDetailLoadResult> => {
  const parentRecordId = recordIdSchema.safeParse(request.recordId);
  if (!parentRecordId.success) return { kind: "unavailable" };
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
      readTimeZone: async () => {
        try {
          const read = await services.readCalendarSettings();
          return read.kind === "available" ? read.value.settings?.timeZone : undefined;
        } catch (error) {
          console.error(`[page] organisation time zone unavailable: ${describeFailure(error)}`);
          return undefined;
        }
      },
    });
    const recordTypeId =
      typeof placement.vortex.queryId === "string"
        ? resolvedQueryRecordTypeId(context, placement.vortex.queryId)
        : undefined;
    const readSubject = (subjectRecordTypeId: string, recordId: string) =>
      services.subjects.read(session, selection, { recordTypeId: subjectRecordTypeId, recordId });
    // A tree table opens the records beneath the row through the table's own read, which takes the
    // person's stored layout and field policy as the page read does.
    const level =
      recordTypeId === undefined || !isTreeTablePlacement(placement)
        ? undefined
        : await readRecordsTableTreeLevel(
            {
              context,
              session,
              selection,
              address: { application: { key: address.application.key }, pageKey: address.pageKey },
              pageDefinition,
              accessVersion:
                typeof projectedPage.value.accessVersion === "number"
                  ? projectedPage.value.accessVersion
                  : undefined,
              subjectType,
              subjectId: subjectRecordId.success ? subjectRecordId.data : undefined,
              parameters,
              bindings,
              data: {},
              services: {
                queries: services.queries,
                linkTiles: services.linkTiles,
                queryNotices: services.queryNotices,
                tables: services.tables,
                resolveRecordLinks: services.recordLinkResolver(context),
                readCalendarSettings: services.readCalendarSettings,
                readSubject,
                launcherValues: applicationLauncherQueryRowsToListValues,
                boardData: (values) =>
                  parseDisplayData({ status: "ready", values }, parseBoardPayload),
              },
              permittedApplicationKeys: undefined,
              permittedApplicationsUnavailable: false,
              gridLayouts: await readPageGridLayouts(
                session,
                dependencies,
                selection,
                context,
                String(pageDefinition.pageId),
                [
                  pageGridLayoutRequest(
                    pageDefinition,
                    placement.placementId,
                    recordTypeId,
                    parameters,
                  ),
                ],
              ),
              markSubjectUnreadable: () => undefined,
            } satisfies PlacementReadInput,
            placement,
            {
              parentRecordId: parentRecordId.data,
              ...(request.pageSize === undefined ? {} : { pageSize: request.pageSize }),
              ...(request.continuationToken === undefined
                ? {}
                : { continuationToken: request.continuationToken }),
            },
          );
    if (level !== undefined) return { kind: "available", detail: level };
    const detail = await readRecordsTableRowDetail({
      context,
      session,
      selection,
      placement,
      parentRecordId: parentRecordId.data,
      ...(request.continuationToken === undefined
        ? {}
        : { continuationToken: request.continuationToken }),
      bindings,
      queries: services.queries,
      readRecord: readSubject,
      resolveRecordLinks: services.recordLinkResolver(context),
    });
    return { kind: "available", detail };
  } finally {
    await Promise.allSettled([projectedPageRead, navigationRead]);
  }
};
