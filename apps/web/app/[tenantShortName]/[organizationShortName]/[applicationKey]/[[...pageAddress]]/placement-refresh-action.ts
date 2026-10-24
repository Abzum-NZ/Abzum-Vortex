"use server";
import { withPageReadAttribution } from "../../../../_lib/page-read-attribution";

import {
  boardColumnReadRequestSchema,
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
  .max(500)
  .transform((placementIds) => [
    ...new Set(placementIds.map((placementId) => placementId.toLowerCase())),
  ]);

const boardReadTargetSchema = z
  .object({
    placementId: containedComponentIdSchema,
    request: boardColumnReadRequestSchema,
  })
  .strict();

/** At most one read per board; a continuation is a read of a single placement. */
const boardReadsSchema = z
  .array(boardReadTargetSchema)
  .max(500)
  .refine(
    (reads) =>
      new Set(reads.map((read) => read.placementId.toLowerCase())).size === reads.length &&
      reads.every((read) => read.request.continuationToken === undefined || reads.length === 1),
    { message: "Each board is read once, and a continuation reads one board" },
  );

const tableContinuationTargetSchema = z
  .object({
    placementId: containedComponentIdSchema,
    /** The position was read from the page address (Back, Forward), so a stale cursor opens page one. */
    fromAddress: z.literal(true).optional(),
    request: z
      .object({
        page: z.number().int().min(1).max(100_000),
        pageDirection: z.enum(["forward", "backward"]),
        continuationToken: z.string().min(1).max(65_536).optional(),
      })
      .strict()
      .superRefine((request, context) => {
        if (
          (request.page === 1 &&
            (request.pageDirection !== "forward" || request.continuationToken !== undefined)) ||
          (request.page > 1 &&
            request.pageDirection === "forward" &&
            request.continuationToken === undefined)
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
  boardReadsInput?: unknown,
  tableContinuationInput?: unknown,
  includeContentInput?: unknown,
): Promise<ApplicationPagePlacementReadResult> {
  return withPageReadAttribution(
    () =>
      readApplicationPlacements(
        addressInput,
        placementIdsInput,
        boardReadsInput,
        tableContinuationInput,
        includeContentInput,
      ),
    "placements",
  );
}

async function readApplicationPlacements(
  addressInput: unknown,
  placementIdsInput: unknown,
  boardReadsInput?: unknown,
  tableContinuationInput?: unknown,
  includeContentInput?: unknown,
): Promise<ApplicationPagePlacementReadResult> {
  const address = placementRefreshAddressSchema.safeParse(addressInput);
  const placementIds = placementIdsSchema.safeParse(placementIdsInput);
  const boardReads =
    boardReadsInput === undefined ? undefined : boardReadsSchema.safeParse(boardReadsInput);
  const tableContinuation =
    tableContinuationInput === undefined
      ? undefined
      : tableContinuationTargetSchema.safeParse(tableContinuationInput);
  const includeContent = z.literal(true).safeParse(includeContentInput).success;
  if (
    !address.success ||
    !placementIds.success ||
    // No placement ids is a content-only refresh: it needs the content flag.
    (placementIds.data.length === 0 && !includeContent) ||
    boardReads?.success === false ||
    tableContinuation?.success === false ||
    (boardReads?.success === true && tableContinuation?.success === true)
  )
    return { kind: "unavailable" };
  if (
    boardReads?.success === true &&
    boardReads.data.some(
      (read) =>
        (read.request.continuationToken !== undefined && placementIds.data.length !== 1) ||
        !placementIds.data.some(
          (placementId) => placementId.toLowerCase() === read.placementId.toLowerCase(),
        ),
    )
  )
    return { kind: "unavailable" };
  if (
    tableContinuation?.success === true &&
    (placementIds.data.length !== 1 ||
      placementIds.data[0]?.toLowerCase() !== tableContinuation.data.placementId.toLowerCase())
  )
    return { kind: "unavailable" };

  const identity = await continueSessionOrEnd(await resolveIdentitySession());
  if (identity.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };

  const resolved = await resolveApplicationAddress(
    identity.session,
    address.data.tenantShortName,
    address.data.organizationShortName,
    address.data.applicationKey,
    address.data.pageKey,
  );
  if (resolved.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
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
      boardReads?.success === true ? boardReads.data : undefined,
      tableContinuation?.success === true
        ? {
            placementId: tableContinuation.data.placementId,
            ...(tableContinuation.data.fromAddress === true ? { fromAddress: true as const } : {}),
            request: {
              page: tableContinuation.data.request.page,
              pageDirection: tableContinuation.data.request.pageDirection,
              ...(tableContinuation.data.request.continuationToken === undefined
                ? {}
                : { continuationToken: tableContinuation.data.request.continuationToken }),
            },
          }
        : undefined,
      includeContent,
    );
  } catch (error) {
    console.error("[page] placement refresh failed", error);
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
