import type { NextRequest, NextResponse } from "next/server";
import {
  containedComponentIdSchema,
  logRefusal,
  recordIdSchema,
  revisionSchema,
} from "@vortex/platform/schema";
import { z } from "zod";
import { resolveApplicationAddress } from "../../_lib/application-address";
import { loadRecordChoicePage } from "../../_lib/application-page/link-input";
import { readBoundedRequestText } from "../_lib/bounded-request-body";
import { getIdentityJourneyConfiguration } from "../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../auth/_lib/session-server";
import { privateJsonResponse as privateResponse } from "../../_lib/private-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumRequestBodyLength = 131_072;

/**
 * One page of the records a link field, or a Records table's link picker (a column filter or a
 * cell editor), on the person's current page may point at.
 */
const requestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
    pageKey: z.string().min(1).max(200),
    placementId: containedComponentIdSchema,
    /** For a Records table's link picker: the field whose target records are offered. */
    fieldId: recordIdSchema.optional(),
    /** Why a Records table's link picker reads: to filter by the records or to edit a cell. */
    purpose: z.enum(["filter", "edit"]).optional(),
    installationRevision: revisionSchema,
    releaseKey: z.string().min(1).max(512),
    subjectRecordId: recordIdSchema.optional(),
    /** For a dependent link field: the record chosen in the field it depends on, in the draft (a form field or an edited cell). */
    parentRecordId: recordIdSchema.optional(),
    search: z.string().trim().max(100).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
    continuationToken: z.string().min(1).max(65_536).optional(),
  })
  .strict()
  .refine((body) => (body.fieldId === undefined) === (body.purpose === undefined), {
    message: "A table link picker names its field and its purpose together",
  })
  .refine(
    (body) =>
      body.parentRecordId === undefined || body.purpose === "edit" || body.fieldId === undefined,
    { message: "Only an edited field's picker names a parent record" },
  );

const refusedResponse = (code: string, cause?: unknown): NextResponse => {
  logRefusal("record-choices", "record choice page", code, cause);
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
      logRefusal("record-choices", "record choice page", "request_not_from_own_site");
      return privateResponse({ kind: "refused", code: "request_not_from_own_site" }, 403);
    }
    const identity = await resolveIdentitySession();
    if (identity.kind === "temporarily_unavailable")
      return privateResponse({ kind: "temporarily_unavailable" }, 503);
    if (identity.kind !== "active") return refusedResponse("identity_not_active");

    const read = await readBoundedRequestText(request, maximumRequestBodyLength);
    if (read.kind === "too_large") {
      logRefusal("record-choices", "record choice page", "body_too_large");
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

    const result = await loadRecordChoicePage(identity.session, address, {
      placementId: body.placementId,
      ...(body.fieldId === undefined || body.purpose === undefined
        ? {}
        : { fieldId: body.fieldId, purpose: body.purpose }),
      installationRevision: body.installationRevision,
      releaseKey: body.releaseKey,
      ...(body.subjectRecordId === undefined ? {} : { subjectRecordId: body.subjectRecordId }),
      ...(body.parentRecordId === undefined ? {} : { parentRecordId: body.parentRecordId }),
      ...(body.search === undefined ? {} : { search: body.search }),
      ...(body.pageSize === undefined ? {} : { pageSize: body.pageSize }),
      ...(body.continuationToken === undefined
        ? {}
        : { continuationToken: body.continuationToken }),
    });
    switch (result.kind) {
      case "completed":
        return privateResponse(
          {
            kind: "completed",
            choices: result.choices,
            ...(result.nextContinuationToken === undefined
              ? {}
              : { nextContinuationToken: result.nextContinuationToken }),
          },
          200,
        );
      case "reload":
        return privateResponse({ kind: "reload" }, 409);
      case "temporarily_unavailable":
        logRefusal("record-choices", "record choice page", "temporarily_unavailable");
        return privateResponse({ kind: "temporarily_unavailable" }, 503);
      default: {
        // A cause may name the fields involved after its code; those stay in the log.
        const [code, ...detail] = result.cause.split(" ");
        return refusedResponse(
          `record_choices_${code}`,
          detail.length === 0 ? undefined : detail.join(" "),
        );
      }
    }
  } catch (error) {
    logRefusal("record-choices", "record choice page", "record_choices_failed", error);
    return privateResponse({ kind: "temporarily_unavailable" }, 503);
  }
}
