"use server";

import { containedComponentIdSchema, revisionSchema } from "@vortex/platform/schema";
import { z } from "zod";
import { continueSessionOrEnd } from "../../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import {
  loadApplicationPivot,
  type PivotLoadResult,
} from "../../../../_lib/application-page/pivot";

const pivotRequestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(80),
    organizationShortName: z.string().min(1).max(80),
    applicationKey: z.string().min(1).max(80),
    pageKey: z.string().min(1).max(80),
    installationRevision: z.number().finite().pipe(revisionSchema),
    search: z.string().max(8_192),
    placementId: containedComponentIdSchema,
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,6000}$/)
      .optional(),
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
 * Reads one page of a table's pivot under the viewer's current page authority. Each opening of the
 * pivot, each change of the table's search or filters and each page of rows is one call; drawing
 * the pivot reads nothing more.
 */
export async function readPivot(input: unknown): Promise<PivotLoadResult> {
  const request = pivotRequestSchema.safeParse(input);
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
    return await loadApplicationPivot(
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
        installationRevision: request.data.installationRevision,
        ...(request.data.cursor === undefined ? {} : { cursor: request.data.cursor }),
      },
    );
  } catch (error) {
    console.error("[page] pivot read failed", error);
    return { kind: "temporarily_unavailable" };
  }
}
