"use server";

import {
  addressedDefaultGridViews,
  authoredGridLayout,
  resolveSelectedGridView,
  containedComponentIdSchema,
  gridLayoutSchema,
  gridViewDocumentSchema,
  gridViewNameSchema,
  gridViewSharingSchema,
  queryIdSchema,
  revisionSchema,
  type GridLayoutCommitResult,
  type GridViewCommandResult,
} from "@vortex/platform/schema";
import {
  addressedGridView,
  readGridViews,
  createHumanOrganizationRequestService,
  createStoredPageCapabilityService,
  runtimeContextSelection,
  projectedUseAvailability,
  deleteGridView,
  gridViewPlacement,
  listGridViewShareTargets,
  resetGridView,
  saveGridView,
  shareGridView,
  writeGridView,
  type GridViewConflict,
  type GridViewOperationOutcome,
  decideRecordTypeFieldIds,
} from "@vortex/platform/server";
import { z } from "zod";
import { continueSessionOrEnd } from "../../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import { humanOrganizationRequestDependencies } from "../../../../_lib/server-composition";
import { platformPermissionSource } from "../../../../_lib/platform-permission-source";
import { collectPlacements } from "../../../../_lib/application-page/placement-helpers";

const gridLayoutAddressSchema = z
  .object({
    tenantShortName: z.string().min(1).max(80),
    organizationShortName: z.string().min(1).max(80),
    applicationKey: z.string().min(1).max(80),
    pageKey: z.string().min(1).max(80),
  })
  .strict();

const viewIdSchema = z.uuid();

const gridLayoutChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("write"),
      placementId: containedComponentIdSchema,
      queryId: queryIdSchema,
      expectedRevision: z.number().pipe(revisionSchema).nullable(),
      /** The saved view the layout was arranged from, when it was. */
      basedOnViewId: viewIdSchema.nullable(),
      layout: gridLayoutSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reset"),
      placementId: containedComponentIdSchema,
      expectedRevision: z.number().pipe(revisionSchema),
    })
    .strict(),
]);

const gridViewChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      placementId: containedComponentIdSchema,
      name: gridViewNameSchema,
      document: gridViewDocumentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("save"),
      placementId: containedComponentIdSchema,
      viewId: viewIdSchema,
      expectedRevision: z.number().pipe(revisionSchema),
      document: gridViewDocumentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rename"),
      placementId: containedComponentIdSchema,
      viewId: viewIdSchema,
      expectedRevision: z.number().pipe(revisionSchema),
      name: gridViewNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("share"),
      placementId: containedComponentIdSchema,
      viewId: viewIdSchema,
      expectedRevision: z.number().pipe(revisionSchema),
      sharing: gridViewSharingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      placementId: containedComponentIdSchema,
      viewId: viewIdSchema,
      expectedRevision: z.number().pipe(revisionSchema),
    })
    .strict(),
  z.object({ kind: z.literal("share_targets"), placementId: containedComponentIdSchema }).strict(),
  z
    .object({
      kind: z.literal("open"),
      placementId: containedComponentIdSchema,
      viewId: viewIdSchema,
    })
    .strict(),
]);

const unavailable: GridLayoutCommitResult = Object.freeze({ outcome: "unavailable" });

const conflictResult = (conflict: GridViewConflict): GridLayoutCommitResult => ({
  outcome: "conflict",
  stored:
    conflict.stored === null
      ? null
      : {
          revision: conflict.stored.revision,
          queryId: conflict.stored.queryId,
          layout: conflict.stored.layout,
        },
});

/**
 * The page a verified person may open and the request service for it. The person, organisation and
 * installation come from the verified session and address, never from the request.
 */
const openGridPage = async (addressInput: unknown, placementId: string) => {
  const address = gridLayoutAddressSchema.safeParse(addressInput);
  if (!address.success) return undefined;
  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") return undefined;
  const resolved = await resolveApplicationAddress(
    identity.session,
    address.data.tenantShortName,
    address.data.organizationShortName,
    address.data.applicationKey,
    address.data.pageKey,
  );
  if (resolved.kind !== "application_page" || resolved.installedContext === undefined)
    return undefined;
  const context = resolved.installedContext;
  const page = context.releaseSet.application.content.pages.find(
    (candidate) => candidate.key === resolved.pageKey,
  );
  if (page === undefined) return undefined;
  const projected = await createStoredPageCapabilityService({
    ...humanOrganizationRequestDependencies(),
    context,
    permissions: platformPermissionSource,
    selection: { pageId: String(page.pageId) },
  }).project(identity.session, runtimeContextSelection(context));
  if (projected.kind !== "available") {
    console.error(`[page] grid placement access unavailable: kind=${projected.kind}`);
    return undefined;
  }
  const placement =
    projected.value === undefined
      ? undefined
      : collectPlacements(projected.value).find(
          (candidate) => candidate.placementId.toLowerCase() === placementId.toLowerCase(),
        );
  if (placement === undefined || projectedUseAvailability(placement) !== "available")
    return undefined;
  const requests = createHumanOrganizationRequestService(humanOrganizationRequestDependencies());
  return {
    page,
    context,
    run: <Result>(
      work: Parameters<typeof requests.runChange<Result>>[2],
    ): ReturnType<typeof requests.runChange<Result>> =>
      requests.runChange(
        identity.session,
        {
          organizationId: resolved.read.organizationId,
          applicationRootId: resolved.application.applicationRootId,
        },
        work,
      ),
  };
};

/**
 * Stores or resets the current person's layout of one data grid on an application page they may
 * open. It reads no records: the grid already shows the change, and only a column it never read
 * needs the grid's own placement reread.
 */
export async function commitGridLayout(
  addressInput: unknown,
  changeInput: unknown,
): Promise<GridLayoutCommitResult> {
  const change = gridLayoutChangeSchema.safeParse(changeInput);
  if (!change.success) return unavailable;
  const opened = await openGridPage(addressInput, change.data.placementId);
  if (opened === undefined) return unavailable;
  const { page } = opened;
  const pageId = String(page.pageId);

  const result = await opened.run(async (transaction): Promise<GridLayoutCommitResult> => {
    const requested = change.data;
    if (requested.kind === "reset") {
      const outcome = await resetGridView(transaction, {
        pageId,
        placementId: requested.placementId,
        expectedRevision: requested.expectedRevision,
      });
      return outcome.outcome === "reset" ? { outcome: "reset" } : conflictResult(outcome);
    }
    const outcome = await writeGridView(transaction, {
      page,
      placementId: requested.placementId,
      queryId: requested.queryId,
      expectedRevision: requested.expectedRevision,
      basedOnViewId: requested.basedOnViewId,
      layout: requested.layout,
    });
    return outcome.outcome === "saved"
      ? { outcome: "saved", revision: outcome.revision }
      : conflictResult(outcome);
  });
  if (result.kind !== "available") {
    console.error(
      `[page] grid layout not stored: code=GRID_LAYOUT_WRITE_FAILED kind=${result.kind}`,
    );
    return unavailable;
  }
  return result.value;
}

const viewResult = (outcome: GridViewOperationOutcome): GridViewCommandResult => {
  switch (outcome.outcome) {
    case "saved":
      return { outcome: "done", viewId: outcome.viewId, revision: outcome.revision };
    case "deleted":
      return { outcome: "done" };
    case "conflict":
    case "forbidden":
    case "limit":
      return { outcome: outcome.outcome };
    case "not_found":
    case "target_unknown":
      return { outcome: "unavailable" };
  }
};

/**
 * Creates, replaces, renames, shares or deletes a saved view of one data grid, or lists who a view
 * can be shared with. The grid's query and share permission come from the installed page, and the
 * database decides now whether this person may change the view: its owner, or someone who holds
 * the share permission. A view stores configuration only, so nothing here reads records.
 */
export async function commitGridView(
  addressInput: unknown,
  changeInput: unknown,
): Promise<GridViewCommandResult> {
  const change = gridViewChangeSchema.safeParse(changeInput);
  if (!change.success) return { outcome: "unavailable" };
  const opened = await openGridPage(addressInput, change.data.placementId);
  if (opened === undefined) return { outcome: "unavailable" };
  const { page } = opened;
  const requested = change.data;
  const placement = gridViewPlacement(page, requested.placementId);
  if (placement === undefined) return { outcome: "unavailable" };
  const pageId = String(page.pageId);
  const { queryId } = placement;

  const result = await opened.run(async (transaction, scope): Promise<GridViewCommandResult> => {
    switch (requested.kind) {
      case "open": {
        const query = opened.context.releaseSet.modules
          .flatMap((module) => module.content.queries)
          .find((query) => String(query.queryId).toLowerCase() === queryId);
        if (query?.recordType.state !== "resolved") return { outcome: "unavailable" };
        const readable = await decideRecordTypeFieldIds(
          transaction,
          scope,
          opened.context,
          String(query.recordType.recordTypeId),
          "read",
        );
        const authored = authoredGridLayout(placement.contract, readable);
        if (authored === undefined || !placement.contract.features.savedViews.enabled)
          return { outcome: "unavailable" };
        const stored = await readGridViews(
          transaction,
          pageId,
          [requested.placementId],
          [requested.viewId],
          placement.contract.features.savedViews.defaultViews.map((view) => ({
            viewId: view.viewId,
            queryId,
            document: view.document,
          })),
        );
        const defaults = addressedDefaultGridViews(
          placement.contract.features.savedViews.defaultViews,
          stored.roleKeys,
          stored.defaultDocuments,
        );
        const addressed =
          defaults.find((view) => view.viewId === requested.viewId) ??
          addressedGridView(
            stored.views.get(requested.placementId.toLowerCase()),
            queryId,
            requested.viewId,
            stored.shareable.has(requested.placementId.toLowerCase()),
          );
        const resolved = resolveSelectedGridView(authored, addressed, readable);
        return resolved.selected === null
          ? { outcome: "unavailable" }
          : {
              outcome: "selected",
              selected: resolved.selected,
              canShare: stored.shareable.has(requested.placementId.toLowerCase()),
            };
      }
      case "create":
        return viewResult(
          await saveGridView(transaction, {
            page,
            placementId: requested.placementId,
            queryId,
            viewId: null,
            expectedRevision: null,
            name: requested.name,
            document: requested.document,
          }),
        );
      case "save":
        return viewResult(
          await saveGridView(transaction, {
            page,
            placementId: requested.placementId,
            queryId,
            viewId: requested.viewId,
            expectedRevision: requested.expectedRevision,
            name: null,
            document: requested.document,
          }),
        );
      case "rename":
        return viewResult(
          await saveGridView(transaction, {
            page,
            placementId: requested.placementId,
            queryId,
            viewId: requested.viewId,
            expectedRevision: requested.expectedRevision,
            name: requested.name,
            document: null,
          }),
        );
      case "share":
        return viewResult(
          await shareGridView(transaction, {
            pageId,
            placementId: requested.placementId,
            viewId: requested.viewId,
            expectedRevision: requested.expectedRevision,
            sharing: requested.sharing,
          }),
        );
      case "delete":
        return viewResult(
          await deleteGridView(transaction, {
            pageId,
            placementId: requested.placementId,
            viewId: requested.viewId,
            expectedRevision: requested.expectedRevision,
          }),
        );
      case "share_targets": {
        const targets = await listGridViewShareTargets(transaction);
        return targets === null ? { outcome: "forbidden" } : { outcome: "targets", targets };
      }
    }
  });
  if (result.kind !== "available") {
    console.error(`[page] grid view not stored: code=GRID_VIEW_WRITE_FAILED kind=${result.kind}`);
    return { outcome: "unavailable" };
  }
  return result.value;
}
