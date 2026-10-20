import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logRefusal, type IdentitySession } from "@vortex/platform/schema";
import {
  createRecordsTableBulkService,
  type RecordsTableBulkAddress,
} from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { getQueryContinuationKey } from "../../../_lib/query-continuation-key";
import { humanOrganizationRequestDependencies } from "../../../_lib/server-composition";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";
import { getIdentityJourneyConfiguration } from "../../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";

const maximumRequestBodyLength = 65_536;

/** The organisation and application of the page the person works on; the body names the rest. */
const addressSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
  })
  .strict();

/** The one bulk service of a Records table, composed for this request. */
export const recordsTableBulkService = () =>
  createRecordsTableBulkService({
    ...humanOrganizationRequestDependencies(),
    channel: "web",
    continuationKey: getQueryContinuationKey(),
  });

export type ResolvedBulkRequest<Body> =
  | Readonly<{
      kind: "resolved";
      session: IdentitySession;
      address: RecordsTableBulkAddress;
      body: Body;
    }>
  | Readonly<{ kind: "response"; response: NextResponse }>;

/**
 * Reads one Records table bulk request: from this site's own JSON client, for the signed-in
 * person, addressed to an application page the person may open now. The page address is resolved
 * on the server; the request body never chooses the organisation or the application.
 */
export const resolveBulkRequest = async <Body extends { pageKey: string }>(
  request: NextRequest,
  route: string,
  bodySchema: z.ZodType<Body>,
): Promise<ResolvedBulkRequest<Body>> => {
  const refused = (code: string, status = 404, cause?: unknown): ResolvedBulkRequest<Body> => {
    logRefusal(route, "records table bulk request", code, cause);
    return { kind: "response", response: privateResponse({ kind: "refused" }, status) };
  };
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    origin === null ||
    origin !== new URL(getIdentityJourneyConfiguration().siteUrl).origin ||
    contentType !== "application/json"
  )
    return refused("request_not_from_own_site", 403);
  const identity = await resolveIdentitySession();
  if (identity.kind === "temporarily_unavailable")
    return { kind: "response", response: privateResponse({ kind: "unavailable" }, 503) };
  if (identity.kind !== "active") return refused("identity_not_active", 401);
  const read = await readBoundedRequestText(request, maximumRequestBodyLength);
  if (read.kind === "too_large") return refused("body_too_large", 413);
  if (read.kind !== "read") return refused("body_unreadable");
  let candidate: unknown;
  try {
    candidate = JSON.parse(read.text);
  } catch (error) {
    return refused("body_not_json", 404, error);
  }
  const addressPart =
    candidate !== null && typeof candidate === "object"
      ? addressSchema.safeParse({
          tenantShortName: (candidate as Record<string, unknown>).tenantShortName,
          organizationShortName: (candidate as Record<string, unknown>).organizationShortName,
          applicationKey: (candidate as Record<string, unknown>).applicationKey,
        })
      : undefined;
  if (addressPart === undefined || !addressPart.success) return refused("address_invalid");
  const addressKeys = new Set(Object.keys(addressSchema.shape));
  const body = bodySchema.safeParse(
    Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>).filter(([key]) => !addressKeys.has(key)),
    ),
  );
  if (!body.success) return refused("body_invalid", 404, body.error);
  const address = await resolveApplicationAddress(
    identity.session,
    addressPart.data.tenantShortName,
    addressPart.data.organizationShortName,
    addressPart.data.applicationKey,
    body.data.pageKey,
  );
  if (address.kind === "temporarily_unavailable")
    return { kind: "response", response: privateResponse({ kind: "unavailable" }, 503) };
  if (address.kind !== "application_page") return refused(`address_${address.kind}`);
  return {
    kind: "resolved",
    session: identity.session,
    address: {
      selection: {
        organizationId: address.read.organizationId,
        applicationRootId: address.application.applicationRootId,
        ...(address.application.previewInstallationId === undefined
          ? {}
          : { previewInstallationId: address.application.previewInstallationId }),
      },
      ...(address.installedContext === undefined
        ? {}
        : { installedContext: address.installedContext }),
    },
    body: body.data,
  };
};
