import { NextResponse, type NextRequest } from "next/server";
import {
  builderKeySchema,
  containedComponentIdSchema,
  referenceChoiceSelectionEvidenceSchema,
  revisionSchema,
} from "@vortex/contracts";
import { z } from "zod";
import { resolveApplicationAddress } from "../../_lib/application-address";
import { loadReferenceChoicePage } from "../../_lib/application-page";
import { readBoundedRequestText } from "../_lib/bounded-request-body";
import {
  getIdentityJourneyConfiguration,
} from "../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { privateJsonResponse as privateResponse } from "../../_lib/private-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumRequestBodyLength = 131_072;

const requestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
    pageKey: z.string().min(1).max(200),
    placementId: containedComponentIdSchema,
    installationRevision: revisionSchema,
    releaseKey: z.string().min(1).max(512),
    search: z.string().trim().max(100).optional(),
    continuationToken: z.string().min(1).max(65_536).optional(),
    selectedKey: builderKeySchema.optional(),
    selectedEvidence: referenceChoiceSelectionEvidenceSchema.optional(),
  })
  .strict();

const refusedResponse = (): NextResponse => privateResponse({ kind: "refused" }, 404);

const fromOwnSite = (request: NextRequest): boolean => {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    origin !== null &&
    origin === new URL(getIdentityJourneyConfiguration().siteUrl).origin &&
    contentType === "application/json"
  );
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!fromOwnSite(request)) return privateResponse({ kind: "refused" }, 403);
    const identity = await resolveIdentitySession();
    if (identity.kind === "temporarily_unavailable")
      return privateResponse({ kind: "temporarily_unavailable" }, 503);
    if (identity.kind !== "active") return refusedResponse();

    const read = await readBoundedRequestText(request, maximumRequestBodyLength);
    if (read.kind === "too_large") return privateResponse({ kind: "refused" }, 413);
    if (read.kind !== "read") return refusedResponse();
    let parsed: z.ZodSafeParseResult<z.infer<typeof requestSchema>>;
    try {
      parsed = requestSchema.safeParse(JSON.parse(read.text));
    } catch {
      return refusedResponse();
    }
    if (!parsed.success) return refusedResponse();
    const body = parsed.data;

    const address = await resolveApplicationAddress(
      identity.session,
      body.tenantShortName,
      body.organizationShortName,
      body.applicationKey,
      body.pageKey,
    );
    if (address.kind === "temporarily_unavailable")
      return privateResponse({ kind: "temporarily_unavailable" }, 503);
    if (address.kind !== "application_page") return refusedResponse();

    const result = await loadReferenceChoicePage(
      identity.session,
      address,
      {
        placementId: body.placementId,
        installationRevision: body.installationRevision,
        releaseKey: body.releaseKey,
        ...(body.search === undefined ? {} : { search: body.search }),
        ...(body.continuationToken === undefined
          ? {}
          : { continuationToken: body.continuationToken }),
        ...(body.selectedKey === undefined ? {} : { selectedKey: body.selectedKey }),
        ...(body.selectedEvidence === undefined
          ? {}
          : { selectedEvidence: body.selectedEvidence }),
      },
    );
    switch (result.kind) {
      case "completed":
        return privateResponse({ kind: "completed", values: result.values }, 200);
      case "reload":
        return privateResponse({ kind: "reload" }, 409);
      case "temporarily_unavailable":
        return privateResponse({ kind: "temporarily_unavailable" }, 503);
      default:
        return refusedResponse();
    }
  } catch {
    return privateResponse({ kind: "temporarily_unavailable" }, 503);
  }
}
