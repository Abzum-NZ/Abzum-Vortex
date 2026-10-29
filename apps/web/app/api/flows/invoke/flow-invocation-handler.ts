import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  flowBindingInvocationSchema,
  logRefusal,
  recordIdSchema,
  sameId,
  type ProtectedOperationChannel,
} from "@vortex/platform/schema";
import { invokeInstalledFlow } from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import {
  loadApplicationPage,
  loadProjectedReferenceChoiceForm,
} from "../../../_lib/application-page";
import { installedReleaseCatalogue } from "../../../_lib/definition-catalogue";
import { applicationStoreService } from "../../../_lib/application-store-service";
import {
  getGuidedFormControlIds,
  getGuidedFormFlowId,
  guidedFormConfirmationKey,
  guidedFormConfirmationReference,
  verifiesGuidedFormConfirmation,
} from "@vortex/platform/server";
import { getQueryContinuationKey } from "../../../_lib/query-continuation-key";
import {
  applicationHasAuthoredForm,
  resolveReferenceChoiceFormValues,
} from "../../../_lib/reference-choices";
import { appTelemetry } from "../../../_lib/server-composition";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";
import {
  getIdentityAuthorityConfiguration,
  getIdentityJourneyConfiguration,
} from "../../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { mapWebError } from "../../../_lib/web-error-mapper";
import {
  projectRowReferenceChoiceForm,
  validateProjectedControlOption,
} from "../../../_lib/application-page/reference-choice";
import { validateProjectedLinkControl } from "../../../_lib/application-page/link-input";

const maximumRequestBodyLength = 131_072;
const requestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
    pageKey: z.string().min(1).max(200),
    pageRecordId: recordIdSchema.optional(),
    pageInputs: z
      .object({
        parameters: z.record(
          z.string().min(1).max(200),
          z.union([z.string(), z.array(z.string())]),
        ),
        controls: z.record(z.string().min(1).max(200), z.string()),
      })
      .strict(),
    invocation: flowBindingInvocationSchema,
  })
  .strict();

const refusedResponse = (): NextResponse => privateResponse({ kind: "refused" }, 404);

/** Cookie-backed starts must originate from this site's JSON client. */
const fromOwnSite = (request: NextRequest): boolean => {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    origin !== null &&
    origin === new URL(getIdentityJourneyConfiguration().siteUrl).origin &&
    contentType === "application/json"
  );
};

/** The route fixes the invocation channel; request data cannot select its Activity attribution. */
export const createFlowInvocationHandler =
  (channel: ProtectedOperationChannel) =>
  async (request: NextRequest): Promise<NextResponse> => {
    const route = channel === "mcp" ? "/api/flows/invoke/mcp" : "/api/flows/invoke";
    try {
      if (!fromOwnSite(request)) return privateResponse({ kind: "refused" }, 403);
      const identity = await resolveIdentitySession();
      if (identity.kind === "temporarily_unavailable")
        return privateResponse({ kind: "unavailable" }, 503);
      if (identity.kind !== "active") return privateResponse({ kind: "refused" }, 401);

      const read = await readBoundedRequestText(request, maximumRequestBodyLength);
      if (read.kind === "too_large") return privateResponse({ kind: "refused" }, 413);
      if (read.kind === "unreadable") return refusedResponse();
      let parsedBody: z.ZodSafeParseResult<z.infer<typeof requestSchema>>;
      try {
        parsedBody = requestSchema.safeParse(JSON.parse(read.text));
      } catch (error) {
        logRefusal(route, "request body", "body_not_json", error);
        return refusedResponse();
      }
      if (!parsedBody.success) {
        logRefusal(route, "request body", "body_schema_invalid", {
          issues: parsedBody.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
          })),
        });
        return refusedResponse();
      }
      const body = parsedBody.data;
      const address = await resolveApplicationAddress(
        identity.session,
        body.tenantShortName,
        body.organizationShortName,
        body.applicationKey,
        body.pageKey,
        "addressed",
      );
      if (address.kind === "temporarily_unavailable")
        return privateResponse({ kind: "unavailable" }, 503);
      if (address.kind !== "application_page") return refusedResponse();

      const result = await invokeInstalledFlow(identity.session, body, address, {
        authorityId: getIdentityAuthorityConfiguration().authorityId,
        applicationStore: applicationStoreService(),
        channel,
        telemetry: appTelemetry,
        releaseCatalogue: installedReleaseCatalogue,
        continuationKey: getQueryContinuationKey(),
        projectRowForm: (bound, context, page, pageId, formId, subject) =>
          projectRowReferenceChoiceForm(
            bound.transaction,
            bound.scope,
            context,
            page,
            pageId,
            formId,
            subject,
          ),
        validateControlOption: (input) => {
          if (input.bound.scope.previewInstallationId !== undefined) {
            console.error("[flows] preview control demand not prepared");
            return Promise.resolve(false);
          }
          return validateProjectedControlOption(
            input.bound,
            input.context,
            input.page,
            input.placementId,
            input.raw,
            input.parsed,
            input.subject,
            (gate) => {
              if (
                input.subject === undefined ||
                !sameId(input.subject.recordTypeId, gate.recordTypeId)
              )
                return new Set();
              const held = Object.entries(input.heldValues).find(([field]) =>
                sameId(field, gate.fieldId),
              )?.[1];
              return new Set(
                typeof held === "string"
                  ? [held]
                  : Array.isArray(held)
                    ? held.filter((value): value is string => typeof value === "string")
                    : [],
              );
            },
            (placementId, selected) =>
              validateProjectedLinkControl(
                input.bound,
                input.context,
                input.page,
                placementId,
                selected,
                input.controls,
                async () => ({ kind: "ready" }),
              ),
          );
        },
        guidedFormControls: getGuidedFormControlIds,
        guidedFormFlowId: getGuidedFormFlowId,
        confirmationKey: guidedFormConfirmationKey,
        confirmationReference: guidedFormConfirmationReference,
        verifiesConfirmation: (proof, details) =>
          verifiesGuidedFormConfirmation(getQueryContinuationKey(), proof, details),
        hasAuthoredForm: applicationHasAuthoredForm,
        projectForm: (session, form) => loadProjectedReferenceChoiceForm(session, address, form),
        resolveFormValues: resolveReferenceChoiceFormValues,
        loadGuidedPage: async (session, guided, subject) => {
          const page = await loadApplicationPage(
            session,
            {
              tenantShortName: body.tenantShortName,
              organizationShortName: body.organizationShortName,
              read: address.read,
              application: address.application,
              pageKey: guided.pageKey,
              ...(address.navigation === undefined ? {} : { navigation: address.navigation }),
            },
            subject === undefined ? {} : { record_id: subject.recordId },
          );
          return page.kind === "available" ? page.model : undefined;
        },
      });
      if (result.kind === "refused") return refusedResponse();
      if (result.kind === "rate_limited") {
        const response = privateResponse({ kind: "refused", code: "flow_rate_limited" }, 429);
        response.headers.set("Retry-After", String(result.retryAfterSeconds));
        return response;
      }
      return privateResponse(result, result.kind === "reload" ? 409 : 200);
    } catch (error) {
      return mapWebError(error, {
        route,
        operation: "invoke",
        code: "FLOW_INVOCATION_FAILED",
        fallback: privateResponse({ kind: "unavailable" }, 503),
      });
    }
  };
