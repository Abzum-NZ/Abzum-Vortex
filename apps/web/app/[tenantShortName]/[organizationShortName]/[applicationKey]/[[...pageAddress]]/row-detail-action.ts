"use server";

import { containedComponentIdSchema, revisionSchema } from "@vortex/platform/schema";
import { z } from "zod";
import { continueSessionOrEnd } from "../../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import {
  loadApplicationRowDetail,
  type RowDetailLoadResult,
} from "../../../../_lib/application-page/row-detail";

const rowDetailRequestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(80),
    organizationShortName: z.string().min(1).max(80),
    applicationKey: z.string().min(1).max(80),
    pageKey: z.string().min(1).max(80),
    installationRevision: z.number().finite().pipe(revisionSchema),
    search: z.string().max(8_192),
    placementId: containedComponentIdSchema,
    recordId: z.string().min(1).max(80),
    continuationToken: z.string().min(1).max(65_536).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const searchParametersOf = (
  search: string,
): Readonly<Record<string, string | readonly string[]>> => {
  const parameters: Record<string, string | readonly string[]> = {};
  for (const [name, value] of new URLSearchParams(search)) {
    const current = parameters[name];
    parameters[name] =
      current === undefined
        ? value
        : typeof current === "string"
          ? [current, value]
          : [...current, value];
  }
  return parameters;
};

/**
 * Reads one page of an expanded row's related records under the viewer's current page authority.
 * Each expand and each "Show more" is one call; collapsing or drawing a row reads nothing.
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
        recordId: request.data.recordId,
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
