import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  logRefusal,
  type IdentitySession,
  type RecordsTableRequestRejection,
} from "@vortex/platform/schema";
import {
  createRecordsTableBulkService,
  createRecordsTableExportService,
  createStoredPageCapabilityService,
  resolveProjectedTablePlacement,
  runtimeContextSelection,
  type RecordsTableBulkAddress,
} from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { platformPermissionSource } from "../../../_lib/platform-permission-source";
import { getQueryContinuationKey } from "../../../_lib/query-continuation-key";
import { humanOrganizationRequestDependencies } from "../../../_lib/server-composition";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";
import { getIdentityJourneyConfiguration } from "../../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";

const defaultMaximumRequestBodyLength = 65_536;

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

/** The one export service of a Records table, composed for this request. */
export const recordsTableExportService = () =>
  createRecordsTableExportService({
    ...humanOrganizationRequestDependencies(),
    channel: "web",
    continuationKey: getQueryContinuationKey(),
  });

export type ResolvedBulkRequest<Body> =
  | Readonly<{
      kind: "resolved";
      session: IdentitySession;
      address: RecordsTableBulkAddress;
      /** The organisation's address names, for the links a page of records shows. */
      names: Readonly<{ tenantShortName: string; organizationShortName: string }>;
      body: Body;
    }>
  | Readonly<{ kind: "response"; response: NextResponse }>;

/**
 * Reads one Records table bulk request: from this site's own JSON client, for the signed-in
 * person, addressed to an application page the person may open now, naming a Records table that is
 * on that page as projected for the person now and usable by them. The page address is resolved on
 * the server; the request body never chooses the organisation or the application, and a table of
 * another page (or one hidden from the person) is refused. A request that carries many values (a
 * batch of cell changes) names its own larger body limit.
 */
export const resolveBulkRequest = async <Body extends { pageKey: string; placementId: string }>(
  request: NextRequest,
  route: string,
  bodySchema: z.ZodType<Body>,
  maximumRequestBodyLength = defaultMaximumRequestBodyLength,
): Promise<ResolvedBulkRequest<Body>> => {
  const refused = (
    code: string,
    reason: RecordsTableRequestRejection["reason"],
    status: number,
    cause?: unknown,
  ): ResolvedBulkRequest<Body> => {
    logRefusal(route, "records table bulk request", code, cause);
    const refusal: RecordsTableRequestRejection = { kind: "refused", reason };
    return { kind: "response", response: privateResponse(refusal, status) };
  };
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    origin === null ||
    origin !== new URL(getIdentityJourneyConfiguration().siteUrl).origin ||
    contentType !== "application/json"
  )
    return refused("request_not_from_own_site", "not_available", 403);
  const identity = await resolveIdentitySession();
  if (identity.kind === "temporarily_unavailable")
    return { kind: "response", response: privateResponse({ kind: "unavailable" }, 503) };
  if (identity.kind !== "active") return refused("identity_not_active", "not_available", 403);
  const read = await readBoundedRequestText(request, maximumRequestBodyLength);
  if (read.kind === "too_large") return refused("body_too_large", "request_invalid", 413);
  if (read.kind !== "read") return refused("body_unreadable", "request_invalid", 400);
  let candidate: unknown;
  try {
    candidate = JSON.parse(read.text);
  } catch (error) {
    return refused("body_not_json", "request_invalid", 400, error);
  }
  const addressPart =
    candidate !== null && typeof candidate === "object"
      ? addressSchema.safeParse({
          tenantShortName: (candidate as Record<string, unknown>).tenantShortName,
          organizationShortName: (candidate as Record<string, unknown>).organizationShortName,
          applicationKey: (candidate as Record<string, unknown>).applicationKey,
        })
      : undefined;
  if (addressPart === undefined || !addressPart.success)
    return refused("address_invalid", "request_invalid", 400);
  const addressKeys = new Set(Object.keys(addressSchema.shape));
  const body = bodySchema.safeParse(
    Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>).filter(([key]) => !addressKeys.has(key)),
    ),
  );
  if (!body.success) return refused("body_invalid", "request_invalid", 400, body.error);
  const address = await resolveApplicationAddress(
    identity.session,
    addressPart.data.tenantShortName,
    addressPart.data.organizationShortName,
    addressPart.data.applicationKey,
    body.data.pageKey,
  );
  if (address.kind === "temporarily_unavailable")
    return { kind: "response", response: privateResponse({ kind: "unavailable" }, 503) };
  if (address.kind !== "application_page")
    return refused(`address_${address.kind}`, "not_available", 403);
  const context = address.installedContext;
  if (context === undefined) return refused("installation_unavailable", "not_available", 403);
  const page = context.releaseSet.application.content.pages.find(
    (candidate) => candidate.key === address.pageKey,
  );
  if (page === undefined) return refused("page_not_installed", "not_available", 403);
  const projected = await createStoredPageCapabilityService({
    ...humanOrganizationRequestDependencies(),
    context,
    permissions: platformPermissionSource,
    selection: { pageId: String(page.pageId) },
  }).project(identity.session, runtimeContextSelection(context));
  if (projected.kind === "temporarily_unavailable")
    return { kind: "response", response: privateResponse({ kind: "unavailable" }, 503) };
  if (projected.kind !== "available" || projected.value === undefined)
    return refused(`page_projection_${projected.kind}`, "not_available", 403);
  // The table must be on this page as projected for the person now, once, and usable by them.
  const resolved = resolveProjectedTablePlacement(projected.value, body.data.placementId, {
    context,
    pageDefinition: page,
    parameters: {},
    subjectId: undefined,
  });
  if (resolved.kind === "refused") return refused(resolved.reason, "not_available", 403);
  return {
    kind: "resolved",
    session: identity.session,
    names: {
      tenantShortName: addressPart.data.tenantShortName,
      organizationShortName: addressPart.data.organizationShortName,
    },
    address: {
      pageId: String(page.pageId),
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
