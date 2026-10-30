import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  flowBindingInvocationSchema,
  logRefusal,
  recordIdSchema,
  sameId,
  type ProtectedOperationChannel,
} from "@vortex/platform/schema";
import {
  invokeInstalledFlow,
  createHumanOrganizationRequestService,
  readAddressedApplicationForFlowInRequest,
  resolvePermittedApplicationAddress,
  flowPlansOf,
  previewInstallationIdOfApplicationKey,
  withRuntimeTransaction,
  withResolvedRequestTransaction,
  type BoundHumanOrganizationRequest,
} from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { loadProjectedReferenceChoiceForm } from "../../../_lib/application-page";
import { loadGuidedConfirmation } from "../../../_lib/application-page/guided-confirmation";
import { installedReleaseCatalogue } from "../../../_lib/definition-catalogue";
import { applicationStoreService } from "../../../_lib/application-store-service";
import { backendAdapter } from "../../../_lib/backend-adapter";
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
import { platformPermissionSource } from "../../../_lib/platform-permission-source";
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
import {
  previewLinkChoiceTypeIds,
  validateProjectedLinkControl,
} from "../../../_lib/application-page/link-input";
import {
  loadInstalledContext,
  requestDependencies,
} from "../../../_lib/application-page/installed-context";
import { prepareRuntimePreviewChoices } from "../../../_lib/runtime-preview-demand";

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

const refusedResponse = (): NextResponse =>
  privateResponse({ kind: "refused", committedNow: false }, 404);

class RolledBackInvocation extends Error {
  constructor(readonly response: NextResponse) {
    super("FLOW_INVOCATION_ROLLBACK");
  }
}

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
    const route = channel === "webmcp" ? "/api/flows/invoke/webmcp" : "/api/flows/invoke";
    try {
      if (!fromOwnSite(request)) return privateResponse({ kind: "refused" }, 403);
      // Read before holding a database transaction: a slow upload must not pin a pooled connection.
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
      let scopedRequestCompleted = false;
      const outcome = await withRuntimeTransaction(
        async (transaction) => {
          const identity = await resolveIdentitySession(transaction);
          if (identity.kind === "temporarily_unavailable")
            return privateResponse({ kind: "unavailable" }, 503);
          if (identity.kind !== "active") return privateResponse({ kind: "refused" }, 401);

          const execute = async (
            address: Extract<
              Awaited<ReturnType<typeof resolveApplicationAddress>>,
              { kind: "application_page" }
            >,
            bound?: BoundHumanOrganizationRequest,
          ): Promise<NextResponse> => {
            if (address.application.previewInstallationId !== undefined) {
              const loaded =
                address.installedContext === undefined
                  ? await loadInstalledContext(identity.session, requestDependencies(), {
                      organizationId: address.read.organizationId,
                      applicationRootId: address.application.applicationRootId,
                      previewInstallationId: address.application.previewInstallationId,
                    })
                  : { kind: "available" as const, value: address.installedContext };
              if (loaded.kind === "temporarily_unavailable")
                return privateResponse({ kind: "unavailable" }, 503);
              if (loaded.kind !== "available") return refusedResponse();
              const page = loaded.value.releaseSet.application.content.pages.find(
                (candidate) => candidate.key === body.pageKey,
              );
              if (page === undefined) return refusedResponse();
              const demand = await prepareRuntimePreviewChoices(
                identity.session,
                loaded.value,
                previewLinkChoiceTypeIds(loaded.value, page),
              );
              if (demand.kind === "temporarily_unavailable")
                return privateResponse({ kind: "unavailable" }, 503);
              if (demand.kind !== "ready") return refusedResponse();
            }

            const result = await invokeInstalledFlow(identity.session, body, address, {
              authorityId: getIdentityAuthorityConfiguration().authorityId,
              ...(bound === undefined ? {} : { boundRequest: bound }),
              applicationStore: applicationStoreService(),
              backend: backendAdapter(),
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
              projectForm: (session, form) =>
                loadProjectedReferenceChoiceForm(session, address, form, bound),
              resolveFormValues: resolveReferenceChoiceFormValues,
              loadGuidedPage: (session, guided, subject) =>
                loadGuidedConfirmation(
                  session,
                  {
                    tenantShortName: body.tenantShortName,
                    organizationShortName: body.organizationShortName,
                    read: address.read,
                    application: address.application,
                    pageKey: guided.pageKey,
                    ...(address.navigation === undefined ? {} : { navigation: address.navigation }),
                    ...(address.installedContext === undefined
                      ? {}
                      : { installedContext: address.installedContext }),
                  },
                  guided,
                  subject,
                  bound,
                ),
            });
            if (result.kind === "refused")
              return privateResponse(result, result.reason === undefined ? 404 : 409);
            if (result.kind === "rate_limited") {
              const response = privateResponse(
                { kind: "refused", code: "flow_rate_limited", committedNow: result.committedNow },
                429,
              );
              response.headers.set("Retry-After", String(result.retryAfterSeconds));
              return response;
            }
            return privateResponse(result, result.kind === "reload" ? 409 : 200);
          };

          // Multi-transaction workflows and previews need their own independently scoped requests.
          if (previewInstallationIdOfApplicationKey(body.applicationKey) === undefined) {
            let scopeFailed = false;
            const requests = createHumanOrganizationRequestService({
              identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
              channel,
              telemetry: appTelemetry,
              resolvedRequestTransaction: async (resolve, operation) => {
                try {
                  return await withResolvedRequestTransaction(resolve, operation, transaction);
                } catch (error) {
                  scopeFailed = true;
                  throw error;
                }
              },
            });
            const scoped = await requests.runAddressed(
              identity.session,
              {
                tenantShortName: body.tenantShortName,
                organizationShortName: body.organizationShortName,
                applicationKey: body.applicationKey,
              },
              async (bound, accountDisplayName, addressIdentity) => {
                const addressed = await readAddressedApplicationForFlowInRequest(
                  platformPermissionSource,
                  bound,
                  {
                    ...body,
                    addressIdentity,
                    ...(accountDisplayName === undefined ? {} : { accountDisplayName }),
                  },
                );
                if (addressed.read.kind !== "available" || addressed.context === undefined)
                  return { kind: "reply" as const, response: refusedResponse() };
                const resolved = resolvePermittedApplicationAddress(
                  addressed.read,
                  body.applicationKey,
                  body.pageKey,
                );
                if (resolved.kind !== "available")
                  return { kind: "reply" as const, response: refusedResponse() };
                const plan = flowPlansOf(addressed.context.releaseSet).plans.get(
                  String(body.invocation.flowId),
                );
                if (plan === undefined)
                  return { kind: "reply" as const, response: refusedResponse() };
                if (
                  plan.segments.some(
                    (segment) =>
                      segment.kind === "server" &&
                      (segment.multiTransaction ||
                        segment.accessChange ||
                        segment.preScopeLock !== null),
                  )
                )
                  return { kind: "separate" as const };
                const address = {
                  kind: "application_page" as const,
                  read: addressed.read,
                  application: resolved.application,
                  pageKey: resolved.pageKey,
                  installedContext: addressed.context,
                };
                return { kind: "reply" as const, response: await execute(address, bound) };
              },
            );
            // The service maps failures after its transaction has rolled back. When it uses the
            // enclosing transaction, propagate the mapped response across that rollback first.
            if (scopeFailed)
              throw new RolledBackInvocation(
                scoped.kind === "temporarily_unavailable"
                  ? privateResponse({ kind: "unavailable" }, 503)
                  : refusedResponse(),
              );
            if (scoped.kind === "temporarily_unavailable")
              return privateResponse({ kind: "unavailable" }, 503);
            if (scoped.kind !== "available") return refusedResponse();
            scopedRequestCompleted = true;
            if (scoped.value.kind === "reply") return scoped.value.response;
          }
          return async () => {
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
            return execute(address);
          };
        },
        { notifyRequestCommit: () => scopedRequestCompleted },
      );
      return typeof outcome === "function" ? await outcome() : outcome;
    } catch (error) {
      if (error instanceof RolledBackInvocation) return error.response;
      return mapWebError(error, {
        route,
        operation: "invoke",
        code: "FLOW_INVOCATION_FAILED",
        fallback: privateResponse({ kind: "unavailable" }, 503),
      });
    }
  };
