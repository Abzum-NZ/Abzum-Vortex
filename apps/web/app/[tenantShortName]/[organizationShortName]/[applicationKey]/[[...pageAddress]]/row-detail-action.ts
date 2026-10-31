"use server";

import { containedComponentIdSchema, revisionSchema } from "@vortex/platform/schema";
import { z } from "zod";
import { continueSessionOrEnd } from "../../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import { pageAddressSchema, searchParametersOf } from "../../../../_lib/page-address-schema";
import {
  loadApplicationRowDetail,
  type RowDetailLoadResult,
} from "../../../../_lib/application-page/row-detail";

const rowDetailRequestSchema = pageAddressSchema
  .extend({
    installationRevision: z.number().finite().pipe(revisionSchema),
    search: z.string().max(8_192),
    placementId: containedComponentIdSchema,
    /** The row whose related records or child records are read. */
    recordId: z.string().min(1).max(80).optional(),
    /** The group of a grouped table whose members are read (the codec's group key). */
    groupKey: z.string().min(1).max(400).optional(),
    direction: z.enum(["forward", "backward"]).optional(),
    continuationToken: z.string().min(1).max(65_536).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine((request) => (request.recordId === undefined) !== (request.groupKey === undefined), {
    message: "A read names either a row or a group",
  });

/**
 * Reads one page of an expanded row's related records, or of an open group's members, under the
 * viewer's current page authority. Each expand and each "Show more" or group page is one call;
 * collapsing or drawing a row or a group reads nothing.
 */
export async function readRowDetail(input: unknown): Promise<RowDetailLoadResult> {
  const request = rowDetailRequestSchema.safeParse(input);
  if (!request.success) return { kind: "unavailable" };
  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  const resolved = await resolveApplicationAddress(
    identity.session,
    request.data.tenantShortName,
    request.data.organizationShortName,
    request.data.applicationKey,
    request.data.pageKey,
  );
  if (resolved.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (resolved.kind !== "application_page") return { kind: "unavailable" };
  try {
    return await loadApplicationRowDetail(
      identity.session,
      {
        tenantShortName: request.data.tenantShortName,
        organizationShortName: request.data.organizationShortName,
        read: resolved.read,
        application: resolved.application,
        pageKey: resolved.pageKey,
        ...(resolved.installedContext === undefined
          ? {}
          : { installedContext: resolved.installedContext }),
      },
      searchParametersOf(request.data.search),
      {
        placementId: request.data.placementId,
        ...(request.data.recordId === undefined ? {} : { recordId: request.data.recordId }),
        ...(request.data.groupKey === undefined ? {} : { groupKey: request.data.groupKey }),
        ...(request.data.direction === undefined ? {} : { direction: request.data.direction }),
        installationRevision: request.data.installationRevision,
        ...(request.data.pageSize === undefined ? {} : { pageSize: request.data.pageSize }),
        ...(request.data.continuationToken === undefined
          ? {}
          : { continuationToken: request.data.continuationToken }),
      },
    );
  } catch (error) {
    console.error("[page] row detail read failed", error);
    return { kind: "temporarily_unavailable" };
  }
}
