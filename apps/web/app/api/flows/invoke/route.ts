import { NextResponse, type NextRequest } from "next/server";
import {
  createHumanOrganizationRequestService,
  createOrganizationAccessAdministrationService,
  createOrganizationRuntimeSettingsAdministrationService,
} from "@vortex/access";
import {
  createAppTelemetryCollector,
  createDatabaseFlowStores,
  createFlowOrchestrator,
  createOperationsAlertSink,
  createProtectedOperationExecutor,
} from "@vortex/app";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { z } from "zod";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import {
  createFlowBindingEndpoint,
  flowBindingInvocationSchema,
  type InstalledFlowBindings,
} from "../../../_lib/flow-binding-endpoint";
import {
  getIdentityAuthorityConfiguration,
  getIdentityJourneyConfiguration,
} from "../../../auth/_lib/authority-configuration";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumRequestBodyLength = 131_072;

/**
 * The browser names only an application address and the invocation. The organisation, installation
 * and bindings are resolved on the server from the signed-in person's own permitted address.
 */
const requestSchema = z
  .object({
    tenantShortName: z.string().min(1).max(200),
    organizationShortName: z.string().min(1).max(200),
    applicationKey: z.string().min(1).max(200),
    invocation: flowBindingInvocationSchema,
  })
  .strict();

const privateResponse = (body: unknown, status: number): NextResponse => {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
};

// One neutral answer for everything that is not a run or a reload: an unknown, foreign or
// withdrawn binding, an unresolved address and a request that does not parse look the same.
const refusedResponse = (): NextResponse => privateResponse({ kind: "refused" }, 404);

const telemetry = createAppTelemetryCollector({ downstream: createOperationsAlertSink() });

/**
 * SEAM: the publication catalogue the installed release was published against. Until a shared
 * catalogue composition exists this is empty, so a release that needs platform catalogue entries
 * fails its integrity check and the endpoint refuses it, never runs it.
 */
const definitionCatalogue = { connectionTypeReleases: [] } as const;

/**
 * The session is a cookie, so a run is accepted only from this site's own pages: a browser always
 * sends Origin on a POST, and a JSON body cannot be sent cross-site without a preflight.
 */
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
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maximumRequestBodyLength) return privateResponse({ kind: "refused" }, 413);
    const text = await request.text();
    if (text.length > maximumRequestBodyLength) return privateResponse({ kind: "refused" }, 413);
    let parsedBody: z.ZodSafeParseResult<z.infer<typeof requestSchema>>;
    try {
      parsedBody = requestSchema.safeParse(JSON.parse(text));
    } catch {
      return refusedResponse();
    }
    if (!parsedBody.success) return refusedResponse();
    const body = parsedBody.data;

    const identity = await resolveIdentitySession();
    if (identity.kind === "temporarily_unavailable")
      return privateResponse({ kind: "unavailable" }, 503);
    if (identity.kind !== "active") return privateResponse({ kind: "refused" }, 401);

    const address = await resolveApplicationAddress(
      identity.session,
      body.tenantShortName,
      body.organizationShortName,
      body.applicationKey,
    );
    if (address.kind === "temporarily_unavailable")
      return privateResponse({ kind: "unavailable" }, 503);
    if (address.kind !== "application_page") return refusedResponse();

    const { authorityId } = getIdentityAuthorityConfiguration();
    const requests = createHumanOrganizationRequestService({
      identityAuthorityId: authorityId,
      telemetry,
    });
    const executor = createProtectedOperationExecutor({
      accessAdministration: createOrganizationAccessAdministrationService({
        identityAuthorityId: authorityId,
        telemetry,
      }),
      runtimeSettings: createOrganizationRuntimeSettingsAdministrationService({
        identityAuthorityId: authorityId,
        telemetry,
      }),
    });
    const stores = createDatabaseFlowStores();

    const endpoint = createFlowBindingEndpoint({
      async readInstallation(session, selection) {
        const read = await requests.run(session, selection, async (transaction) => {
          const installation =
            await createActiveApplicationInstallationRepository(transaction).readCurrent();
          const releaseSet = await createDatabaseApplicationBoundReleaseSetService(
            definitionCatalogue,
            transaction,
          ).read({ applicationReleaseRevision: installation.applicationReleaseRevision });
          const application = releaseSet.application;
          const flows = new Map<string, unknown>();
          for (const flow of [
            ...application.content.flows,
            ...releaseSet.modules.flatMap((module) => module.content.flows),
          ]) {
            // One flow per identity: a Module flow never shadows an Application flow, and an
            // ambiguous release is refused rather than run.
            if (flows.has(String(flow.id))) throw new Error("FLOW_IDENTITY_AMBIGUOUS");
            flows.set(String(flow.id), flow);
          }
          const installed: InstalledFlowBindings = {
            organizationId: installation.organizationId,
            installationRevision: installation.applicationReleaseRevision,
            releaseKey: [
              application.releaseVersion,
              application.contentFingerprint,
              application.resolutionFingerprint,
            ].join(":"),
            bindings: application.content.flowBindings,
            flows,
          };
          return installed;
        });
        return read.kind === "available" ? read.value : undefined;
      },
      orchestratorFor: (release, runId) =>
        createFlowOrchestrator({
          executor,
          continuations: stores.continuations,
          ledger: stores.ledger,
          // The release was read from the trusted installation for this exact request.
          resolveRelease: async () => release,
          ...(runId === undefined ? {} : { newRunId: () => runId }),
        }),
    });

    const result = await endpoint.invoke(identity.session, {
      organizationId: address.read.organizationId,
      applicationRootId: address.application.applicationRootId,
    }, body.invocation);
    if (result.kind === "refused") return refusedResponse();
    return privateResponse(result, result.kind === "reload" ? 409 : 200);
  } catch {
    return privateResponse({ kind: "unavailable" }, 503);
  }
}
