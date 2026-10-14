"use server";

import {
  boardColumnContinuationRequestSchema,
  containedComponentIdSchema,
  revisionSchema,
} from "@vortex/platform/schema";
import { z } from "zod";
import { continueSessionOrEnd } from "../../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import {
  loadApplicationPagePlacements,
  type ApplicationPagePlacementReadResult,
  type PageDataState,
} from "../../../../_lib/application-page";

const placementRefreshAddressSchema = z
  .object({
    tenantShortName: z.string().min(1).max(80),
    organizationShortName: z.string().min(1).max(80),
    applicationKey: z.string().min(1).max(80),
    pageKey: z.string().min(1).max(80),
    installationRevision: z.number().finite().pipe(revisionSchema),
    search: z.string().max(8_192),
  })
  .strict();

const placementIdsSchema = z
  .array(containedComponentIdSchema)
  .min(1)
  .max(500)
  .transform((placementIds) =>
    [...new Set(placementIds.map((placementId) => placementId.toLowerCase()))],
  );

const boardContinuationTargetSchema = z
  .object({
    placementId: containedComponentIdSchema,
    request: boardColumnContinuationRequestSchema,
  })
  .strict();

const tableContinuationTargetSchema = z
  .object({
    placementId: containedComponentIdSchema,
    request: z
      .object({
        page: z.number().int().min(1).max(100_000),
        continuationToken: z.string().min(1).max(65_536).optional(),
      })
      .strict()
      .superRefine((request, context) => {
        if (
          (request.page === 1 && request.continuationToken !== undefined) ||
          (request.page > 1 && request.continuationToken === undefined)
        )
          context.addIssue({
            code: "custom",
            path: ["continuationToken"],
            message: "The table page and continuation token do not agree",
          });
      }),
  })
  .strict();

const unavailablePlacement = Object.freeze({ status: "error" }) satisfies PageDataState;

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

/** Re-reads only named placements after resolving the viewer's current page authority. */
export async function rereadApplicationPlacements(
  addressInput: unknown,
  placementIdsInput: unknown,
  boardContinuationInput?: unknown,
  tableContinuationInput?: unknown,
): Promise<ApplicationPagePlacementReadResult> {
  const address = placementRefreshAddressSchema.safeParse(addressInput);
  const placementIds = placementIdsSchema.safeParse(placementIdsInput);
  const boardContinuation =
    boardContinuationInput === undefined
      ? undefined
      : boardContinuationTargetSchema.safeParse(boardContinuationInput);
  const tableContinuation =
    tableContinuationInput === undefined
      ? undefined
      : tableContinuationTargetSchema.safeParse(tableContinuationInput);
  if (
    !address.success ||
    !placementIds.success ||
    boardContinuation?.success === false ||
    tableContinuation?.success === false ||
    (boardContinuation?.success === true && tableContinuation?.success === true)
  )
    return { kind: "unavailable" };
  if (
    boardContinuation?.success === true &&
    (placementIds.data.length !== 1 ||
      placementIds.data[0]?.toLowerCase() !== boardContinuation.data.placementId.toLowerCase())
  )
    return { kind: "unavailable" };
  if (
    tableContinuation?.success === true &&
    (placementIds.data.length !== 1 ||
      placementIds.data[0]?.toLowerCase() !== tableContinuation.data.placementId.toLowerCase())
  )
    return { kind: "unavailable" };

  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };

  const resolved = await resolveApplicationAddress(
    identity.session,
    address.data.tenantShortName,
    address.data.organizationShortName,
    address.data.applicationKey,
    address.data.pageKey,
  );
  if (resolved.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  if (resolved.kind !== "application_page") return { kind: "unavailable" };

  try {
    return await loadApplicationPagePlacements(
      identity.session,
      {
        tenantShortName: address.data.tenantShortName,
        organizationShortName: address.data.organizationShortName,
        read: resolved.read,
        application: resolved.application,
        pageKey: resolved.pageKey,
      },
      searchParametersOf(address.data.search),
      placementIds.data,
      address.data.installationRevision,
      boardContinuation?.success === true ? boardContinuation.data : undefined,
      tableContinuation?.success === true
        ? {
            placementId: tableContinuation.data.placementId,
            request: {
              page: tableContinuation.data.request.page,
              ...(tableContinuation.data.request.continuationToken === undefined
                ? {}
                : { continuationToken: tableContinuation.data.request.continuationToken }),
            },
          }
        : undefined,
    );
  } catch {
    return {
      kind: "available",
      data: Object.fromEntries(
        placementIds.data.map((placementId) => [placementId, unavailablePlacement]),
      ),
      editFormBaselines: Object.fromEntries(
        placementIds.data.map((placementId) => [placementId, null]),
      ),
      subject: null,
    };
  }
}
