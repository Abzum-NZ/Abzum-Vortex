"use server";

import {
  containedComponentIdSchema,
  gridLayoutSchema,
  queryIdSchema,
  revisionSchema,
  type GridLayoutCommitResult,
} from "@vortex/platform/schema";
import {
  createHumanOrganizationRequestService,
  resetGridView,
  writeGridView,
  type GridViewConflict,
} from "@vortex/platform/server";
import { z } from "zod";
import { continueSessionOrEnd } from "../../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import { humanOrganizationRequestDependencies } from "../../../../_lib/server-composition";

const gridLayoutAddressSchema = z
  .object({
    tenantShortName: z.string().min(1).max(80),
    organizationShortName: z.string().min(1).max(80),
    applicationKey: z.string().min(1).max(80),
    pageKey: z.string().min(1).max(80),
  })
  .strict();

const gridLayoutChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("write"),
      placementId: containedComponentIdSchema,
      queryId: queryIdSchema,
      expectedRevision: z.number().pipe(revisionSchema).nullable(),
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
 * Stores or resets the current person's layout of one data grid on an application page they may
 * open. It reads no records: the grid already shows the change, and only a column it never read
 * needs the grid's own placement reread. The person, organisation and installation come from the
 * verified session and address, never from the request.
 */
export async function commitGridLayout(
  addressInput: unknown,
  changeInput: unknown,
): Promise<GridLayoutCommitResult> {
  const address = gridLayoutAddressSchema.safeParse(addressInput);
  const change = gridLayoutChangeSchema.safeParse(changeInput);
  if (!address.success || !change.success) return unavailable;

  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") return unavailable;
  const resolved = await resolveApplicationAddress(
    identity.session,
    address.data.tenantShortName,
    address.data.organizationShortName,
    address.data.applicationKey,
    address.data.pageKey,
  );
  if (resolved.kind !== "application_page" || resolved.installedContext === undefined)
    return unavailable;
  const page = resolved.installedContext.releaseSet.application.content.pages.find(
    (candidate) => candidate.key === resolved.pageKey,
  );
  if (page === undefined) return unavailable;
  const pageId = String(page.pageId);

  const result = await createHumanOrganizationRequestService(
    humanOrganizationRequestDependencies(),
  ).runChange(
    identity.session,
    {
      organizationId: resolved.read.organizationId,
      applicationRootId: resolved.application.applicationRootId,
    },
    async (transaction): Promise<GridLayoutCommitResult> => {
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
        layout: requested.layout,
      });
      return outcome.outcome === "saved"
        ? { outcome: "saved", revision: outcome.revision }
        : conflictResult(outcome);
    },
  );
  if (result.kind !== "available") {
    console.error(
      `[page] grid layout not stored: code=GRID_LAYOUT_WRITE_FAILED kind=${result.kind}`,
    );
    return unavailable;
  }
  return result.value;
}
