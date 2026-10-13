import type { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  builderKeySchema,
  logRefusal,
  containedComponentIdSchema,
  referenceChoiceSelectionEvidenceSchema,
  revisionSchema,
} from "@vortex/platform/schema";
import { z } from "zod";
import { resolveApplicationAddress } from "../../_lib/application-address";
import { loadReferenceChoicePage } from "../../_lib/application-page";
import { readBoundedRequestText } from "../_lib/bounded-request-body";
import { getIdentityJourneyConfiguration } from "../../auth/_lib/authority-configuration";
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
    dependencyChoice: z
      .object({
        key: builderKeySchema,
        evidence: referenceChoiceSelectionEvidenceSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const refusedResponse = (code: string, cause?: unknown): NextResponse => {
  logRefusal("reference-choices", "choice page", code, cause);
  return privateResponse({ kind: "refused", code }, 404);
};

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
    if (!fromOwnSite(request)) {
      logRefusal("reference-choices", "choice page", "request_not_from_own_site");
      return privateResponse({ kind: "refused", code: "request_not_from_own_site" }, 403);
    }
    const identity = await resolveIdentitySession();
    if (identity.kind === "temporarily_unavailable")
      return privateResponse({ kind: "temporarily_unavailable" }, 503);
    if (identity.kind !== "active") return refusedResponse("identity_not_active");

    const read = await readBoundedRequestText(request, maximumRequestBodyLength);
    if (read.kind === "too_large") {
      logRefusal("reference-choices", "choice page", "body_too_large");
      return privateResponse({ kind: "refused", code: "body_too_large" }, 413);
    }
    if (read.kind !== "read") return refusedResponse("body_unreadable");
    let parsed: z.ZodSafeParseResult<z.infer<typeof requestSchema>>;
    try {
      parsed = requestSchema.safeParse(JSON.parse(read.text));
    } catch (error) {
      return refusedResponse("body_not_json", error);
    }
    if (!parsed.success) return refusedResponse("body_invalid", parsed.error);
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
    if (address.kind !== "application_page") return refusedResponse(`address_${address.kind}`);

    const result = await loadReferenceChoicePage(identity.session, address, {
      placementId: body.placementId,
      installationRevision: body.installationRevision,
      releaseKey: body.releaseKey,
      ...(body.search === undefined ? {} : { search: body.search }),
      ...(body.continuationToken === undefined
        ? {}
        : { continuationToken: body.continuationToken }),
      ...(body.selectedKey === undefined ? {} : { selectedKey: body.selectedKey }),
      ...(body.selectedEvidence === undefined ? {} : { selectedEvidence: body.selectedEvidence }),
      ...(body.dependencyChoice === undefined ? {} : { dependencyChoice: body.dependencyChoice }),
    });
    switch (result.kind) {
      case "completed":
        return privateResponse({ kind: "completed", values: result.values }, 200);
      case "reload":
        return privateResponse({ kind: "reload" }, 409);
      case "temporarily_unavailable":
        return privateResponse({ kind: "temporarily_unavailable" }, 503);
      default:
        return refusedResponse(`choice_page_${result.kind}`);
    }
  } catch (error) {
    logRefusal("reference-choices", "choice page", "choice_page_failed", error);
    return privateResponse({ kind: "temporarily_unavailable" }, 503);
  }
}
