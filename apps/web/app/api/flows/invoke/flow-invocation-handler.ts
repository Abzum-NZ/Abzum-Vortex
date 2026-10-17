import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  flowBindingInvocationSchema,
  logRefusal,
  type ProtectedOperationChannel,
} from "@vortex/platform/schema";
import { invokeInstalledFlow } from "@vortex/platform/server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import {
  loadApplicationPage,
  loadProjectedReferenceChoiceForm,
} from "../../../_lib/application-page";
import { installedReleaseCatalogue } from "../../../_lib/definition-catalogue";
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

const maximumRequestBodyLength = 131_072;
const requestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
    pageKey: z.string().min(1).max(200),
    invocation: flowBindingInvocationSchema,
  })
  .strict();

// VXPERF-TEMP: temporary #2811 instrumentation, never committed.
import { AsyncLocalStorage as VxAls } from "node:async_hooks";
type VxStore = { t0: number; spans: { name: string; start: number; ms: number }[]; tx: { label: string; start: number; ms: number; queries: number; queryMs: number }[] };
const vxGlobal = globalThis as unknown as { __vxPerf?: VxAls<VxStore>; __vxSpan?: <T>(name: string, operation: () => Promise<T>) => Promise<T> };
vxGlobal.__vxPerf ??= new VxAls<VxStore>();
vxGlobal.__vxSpan ??= async <T,>(name: string, operation: () => Promise<T>): Promise<T> => {
  const store = vxGlobal.__vxPerf?.getStore();
  if (store === undefined) return operation();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    store.spans.push({ name, start: Math.round((start - store.t0) * 10) / 10, ms: Math.round((performance.now() - start) * 10) / 10 });
  }
};
const vxSpan = vxGlobal.__vxSpan;

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
    const store: VxStore = { t0: performance.now(), spans: [], tx: [] };
    const response = await vxGlobal.__vxPerf!.run(store, () => vxHandle(request, channel));
    const total = performance.now() - store.t0;
    const body = await response.clone().text();
    const txMs = store.tx.reduce((sum, tx) => sum + tx.ms, 0);
    const queryMs = store.tx.reduce((sum, tx) => sum + tx.queryMs, 0);
    const queries = store.tx.reduce((sum, tx) => sum + tx.queries, 0);
    console.log(`VXPERF ${JSON.stringify({ at: new Date().toISOString(), status: response.status, total: Math.round(total * 10) / 10, responseBytes: body.length, requestBytes: Number(request.headers.get("content-length") ?? 0), txCount: store.tx.length, txMs: Math.round(txMs), queries, queryMs: Math.round(queryMs), kind: (() => { try { const parsed = JSON.parse(body) as { kind?: string; continuation?: string }; return `${parsed.kind ?? "?"}${parsed.continuation === undefined ? "" : `:cont${parsed.continuation.length}`}`; } catch { return "?"; } })(), spans: store.spans, tx: store.tx })}`);
    response.headers.set("Server-Timing", `total;dur=${total.toFixed(1)}, db;dur=${txMs.toFixed(1)}, tx;desc="${store.tx.length}"`);
    response.headers.set("x-vx-perf", JSON.stringify({ total: Math.round(total), txCount: store.tx.length, txMs: Math.round(txMs), queries, queryMs: Math.round(queryMs) }));
    return response;
  };

const vxHandle = async (request: NextRequest, channel: ProtectedOperationChannel = "web"): Promise<NextResponse> => {
    const route = channel === "mcp" ? "/api/flows/invoke/mcp" : "/api/flows/invoke";
    try {
      if (!fromOwnSite(request)) return privateResponse({ kind: "refused" }, 403);
      const identity = await vxSpan("route.identity", () => resolveIdentitySession());
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
      if (!parsedBody.success) return refusedResponse();
      const body = parsedBody.data;
      const address = await vxSpan("route.address", () => resolveApplicationAddress(
        identity.session,
        body.tenantShortName,
        body.organizationShortName,
        body.applicationKey,
        body.pageKey,
      ));
      if (address.kind === "temporarily_unavailable")
        return privateResponse({ kind: "unavailable" }, 503);
      if (address.kind !== "application_page") return refusedResponse();

      const result = await vxSpan("route.invoke", () => invokeInstalledFlow(identity.session, body, address, {
        authorityId: getIdentityAuthorityConfiguration().authorityId,
        channel,
        telemetry: appTelemetry,
        releaseCatalogue: installedReleaseCatalogue,
        continuationKey: getQueryContinuationKey(),
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
            },
            subject === undefined ? {} : { record_id: subject.recordId },
          );
          return page.kind === "available" ? page.model : undefined;
        },
      }));
      if (result.kind === "refused") return refusedResponse();
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
