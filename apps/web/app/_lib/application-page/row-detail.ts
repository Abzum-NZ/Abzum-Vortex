import "server-only";

import {
  readRecordsTableRowDetail,
  resolveProjectedTablePlacement,
  isGroupingTablePlacement,
  isTreeTablePlacement,
  readRecordsTableGroupMembers,
  readRecordsTableTreeLevel,
  type GroupMembersResult,
  type PlacementReadInput,
  type RowDetailResult,
  type TreeLevelResult,
} from "@vortex/platform/server";
import {
  recordIdSchema,
  sameId,
  type OrganizationSelectionCandidate,
  type IdentitySession,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "../query-continuation-key";
import { loadInstalledContext, readPageProjections, requestDependencies } from "./load";
import { pageGridLayoutRequest, readPageGridLayouts } from "./grid-layouts";
import { first, pageSubjectParameter } from "./placement-helpers";
import { createPlacementReadServices } from "./placement-services";
import type { ApplicationPageLoaderAddress, SearchParameters } from "./types";

export type RowDetailLoadResult =
  | Readonly<{
      kind: "available";
      detail: RowDetailResult | TreeLevelResult | GroupMembersResult;
    }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * Reads one expanded row's related records, or one page of an open group's members, on the
 * viewer's current page. The page is projected again for this viewer, so the Records table must
 * still be on it and usable; the row, the related records query and its inputs, or the group's
 * field, are all decided on the server by the platform's read. The browser supplies the page
 * address, the table's placement, the row's record identity or the group's key, and a continuation
 * token the Query engine sealed for this same read.
 */
export const loadApplicationRowDetail = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  request: Readonly<{
    placementId: string;
    /** A row of the table, or a group of it (`groupKey`): exactly one is named. */
    recordId?: string;
    groupKey?: string;
    direction?: "forward" | "backward";
    continuationToken?: string;
    pageSize?: number;
    installationRevision: number;
  }>,
): Promise<RowDetailLoadResult> => {
  const parentRecordId = recordIdSchema.safeParse(request.recordId);
  if (request.groupKey === undefined && !parentRecordId.success) return { kind: "unavailable" };
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
    undefined,
  );
  try {
    const projectedPage = await projectedPageRead;
    if (projectedPage.kind !== "available") return projectedPage;
    if (projectedPage.value === undefined) return { kind: "unavailable" };
    const resolved = resolveProjectedTablePlacement(projectedPage.value, request.placementId, {
      context,
      pageDefinition,
      parameters,
      subjectId,
    });
    if (resolved.kind === "refused") {
      console.error(`[row-detail] refused: ${resolved.reason}`);
      return { kind: "unavailable" };
    }
    const { placement, recordTypeId, subjectRecordType: subjectType } = resolved;
    const services = createPlacementReadServices({
      session,
      selection,
      dependencies,
      continuationKey: getQueryContinuationKey(),
      tenantShortName: address.tenantShortName,
      organizationShortName: address.organizationShortName,
    });
    const readSubject = (subjectRecordTypeId: string, recordId: string) =>
      services.subjects.read(session, selection, { recordTypeId: subjectRecordTypeId, recordId });
    const bindings = resolved.bindings({
      readSubject,
      readTimeZone: services.readTimeZone,
      readViewerTeams: services.readViewerTeams,
    });
    // A tree level and a group's members are read through the table's own read, which takes the
    // person's stored layout and field policy as the page read does.
    const accessVersion = projectedPage.value.accessVersion;
    const tableRead = async (tableRecordTypeId: string): Promise<PlacementReadInput> =>
      ({
        context,
        session,
        selection,
        address: { application: { key: address.application.key }, pageKey: address.pageKey },
        pageDefinition,
        accessVersion: typeof accessVersion === "number" ? accessVersion : undefined,
        subjectType,
        subjectId: resolved.subjectRecordId,
        parameters,
        bindings,
        data: {},
        services: services.placementServices(services.recordLinkResolver(context), readSubject),
        permittedApplicationKeys: undefined,
        permittedApplicationsUnavailable: false,
        gridLayouts: await readPageGridLayouts(
          session,
          dependencies,
          selection,
          String(pageDefinition.pageId),
          [
            pageGridLayoutRequest(
              pageDefinition,
              placement.placementId,
              tableRecordTypeId,
              parameters,
            ),
          ],
        ),
        markSubjectUnreadable: () => undefined,
      }) satisfies PlacementReadInput;
    if (request.groupKey !== undefined) {
      if (recordTypeId === undefined || !isGroupingTablePlacement(placement))
        return { kind: "unavailable" };
      return {
        kind: "available",
        detail: (await readRecordsTableGroupMembers(await tableRead(recordTypeId), placement, {
          groupKey: request.groupKey,
          ...(request.direction === undefined ? {} : { direction: request.direction }),
          ...(request.continuationToken === undefined
            ? {}
            : { continuationToken: request.continuationToken }),
        })) ?? { status: "error" },
      };
    }
    if (!parentRecordId.success) return { kind: "unavailable" };
    const level =
      recordTypeId === undefined || !isTreeTablePlacement(placement)
        ? undefined
        : await readRecordsTableTreeLevel(await tableRead(recordTypeId), placement, {
            parentRecordId: parentRecordId.data,
            ...(request.pageSize === undefined ? {} : { pageSize: request.pageSize }),
            ...(request.continuationToken === undefined
              ? {}
              : { continuationToken: request.continuationToken }),
          });
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
