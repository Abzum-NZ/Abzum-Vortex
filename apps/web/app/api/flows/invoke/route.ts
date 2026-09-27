import { NextResponse, type NextRequest } from "next/server";
import {
  createOrganizationAccessAdministrationService,
  createOrganizationRuntimeSettingsAdministrationService,
} from "@vortex/access";
import {
  createDatabaseFlowStores,
  createFlowOrchestrator,
  createFormContinuationService,
  createProtectedOperationExecutor,
  type FlowNamedAction,
  type FlowRecordType,
  type FlowRelease,
} from "@vortex/app";
import {
  flowTaskChildLists,
  installedNamedActionReferenceV2Schema,
  type FlowDefinition,
  type FlowTask,
  type FormContinuationOutcome,
  type FormContinuationRequest,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createTenantGovernanceService } from "@vortex/identity";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import {
  createPageFormRequestAdapter,
  createPageSubjectReader,
  createPrivateFormSubmitAdapter,
} from "@vortex/page";
import { createNamedActionRecordPort, createRecordSaveService } from "@vortex/record";
import type { RuntimeDatabaseTransaction } from "@vortex/db";
import { z } from "zod";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { readBoundedRequestText } from "../../_lib/bounded-request-body";
import { installedReleaseCatalogue } from "../../../_lib/definition-catalogue";
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
import { privateJsonResponse as privateResponse } from "../../../_lib/private-response";
import { appTelemetry as telemetry, humanOrganizationRequests } from "../../../_lib/server-composition";

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

// One neutral answer for everything that is not a run or a reload: an unknown, foreign or
// withdrawn binding, an unresolved address and a request that does not parse look the same.
const refusedResponse = (): NextResponse => privateResponse({ kind: "refused" }, 404);

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

/**
 * Whether an installed flow declares the paused node a continuation target names (#544): a task
 * with that id anywhere in the flow and, for a form, a Show form task whose fixed form is the named
 * one (a confirmation names no form). The stored run still pins the exact node; this refuses a
 * target the installed flow could never pause at before the continuation is spent.
 */
const declaresPausedNode = (
  flow: unknown,
  node: Readonly<{ nodeId: string; formId?: string }>,
): boolean => {
  const definition = flow as Partial<Pick<FlowDefinition, "tasks" | "errors" | "finally">>;
  const find = (tasks: readonly FlowTask[] | undefined): FlowTask | undefined => {
    for (const task of tasks ?? []) {
      if (task.id === node.nodeId) return task;
      for (const child of flowTaskChildLists(task)) {
        const found = find(child.tasks);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const task = find(definition.tasks) ?? find(definition.errors) ?? find(definition.finally);
  if (task === undefined) return false;
  if (node.formId === undefined) return task.type === "interface.confirm";
  if (task.type !== "interface.show_form") return false;
  const form = (task as { properties?: Record<string, unknown> }).properties?.form as
    | Readonly<{ kind?: unknown; literal?: Readonly<{ value?: unknown }> }>
    | undefined;
  // A form chosen by a reference or formula is only known at run time; the stored run pins it.
  if (form?.kind !== "literal") return form !== undefined;
  return String(form.literal?.value).toLowerCase() === node.formId.toLowerCase();
};

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    } catch {
      return refusedResponse();
    }
    if (!parsedBody.success) return refusedResponse();
    const body = parsedBody.data;

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
    const requests = humanOrganizationRequests(authorityId);
    const executor = createProtectedOperationExecutor({
      accessAdministration: createOrganizationAccessAdministrationService({
        identityAuthorityId: authorityId,
        telemetry,
      }),
      runtimeSettings: createOrganizationRuntimeSettingsAdministrationService({
        identityAuthorityId: authorityId,
        telemetry,
      }),
      tenantGovernance: {
        run: (session, selection, operation) =>
          requests.runChange(session, selection, (transaction, scope) =>
            operation({
              tenantId: scope.tenantId,
              operations: createTenantGovernanceService({
                runtimeTransaction: <Result>(
                  run: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
                ) => run(transaction),
              }),
            }),
          ),
      },
    });
    const stores = createDatabaseFlowStores();
    // #1369, #1370: Save record tasks and named actions run through the record service's own
    // protected paths, under the initiator's verified request and in their own transactions.
    const records = createRecordSaveService({ identityAuthorityId: authorityId, telemetry });
    const subjectReader = createPageSubjectReader({ identityAuthorityId: authorityId, telemetry });
    const actionRecords = createNamedActionRecordPort({
      identityAuthorityId: authorityId,
      telemetry,
    });
    const orchestratorFor = (release: FlowRelease, runId?: string) =>
      createFlowOrchestrator({
        executor,
        records,
        actionRecords,
        subjects: {
          read: async (session, selection, subject) =>
            (await subjectReader.read(session, selection, subject)).kind,
        },
        continuations: stores.continuations,
        ledger: stores.ledger,
        // The release was read from the trusted installation for this exact request.
        resolveRelease: async () => release,
        ...(runId === undefined ? {} : { newRunId: () => runId }),
      });

    /** The trusted active installation for the initiator's own selection; never from the request. */
    const readInstalled = async (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
    ): Promise<InstalledFlowBindings | undefined> => {
      const read = await requests.run(session, selection, async (transaction) => {
        const installation =
          await createActiveApplicationInstallationRepository(transaction).readCurrent();
        const releaseSet = await createDatabaseApplicationBoundReleaseSetService(
          installedReleaseCatalogue,
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
        // Each record type's fields by key and by identity, for the values of a Save record task.
        const recordTypes = new Map<string, FlowRecordType>();
        for (const recordType of releaseSet.modules.flatMap((module) => module.content.recordTypes)) {
          const fieldIds = new Map<string, string>();
          for (const field of recordType.fields) {
            fieldIds.set(String(field.key).toLowerCase(), String(field.fieldId));
            fieldIds.set(String(field.fieldId).toLowerCase(), String(field.fieldId));
          }
          recordTypes.set(String(recordType.recordTypeId).toLowerCase(), { fieldIds });
        }
        // Each installed named action by its key, as the exact action a Call protected operation
        // task names. An ambiguous key names no action rather than a guessed one.
        const namedActions = new Map<string, FlowNamedAction>();
        const ambiguousActionKeys = new Set<string>();
        const addActions = (
          owner: Readonly<{
            ownerKind: "application" | "module";
            ownerId: string;
            releaseRevision: number;
          }>,
          actions: readonly Readonly<{
            actionId: string;
            key: string;
            subjectRecordTypeId: string;
          }>[],
        ) => {
          for (const action of actions) {
            const key = String(action.key);
            const reference = installedNamedActionReferenceV2Schema.safeParse({
              ...owner,
              actionId: action.actionId,
            });
            if (!reference.success) continue;
            if (namedActions.has(key) || ambiguousActionKeys.has(key)) {
              namedActions.delete(key);
              ambiguousActionKeys.add(key);
              continue;
            }
            namedActions.set(key, {
              action: reference.data,
              subjectRecordTypeId: String(action.subjectRecordTypeId),
            });
          }
        };
        addActions(
          {
            ownerKind: "application",
            ownerId: application.rootId,
            releaseRevision: application.releaseRevision,
          },
          application.content.actions,
        );
        for (const module of releaseSet.modules)
          addActions(
            {
              ownerKind: "module",
              ownerId: module.rootId,
              releaseRevision: module.releaseRevision,
            },
            module.content.actions,
          );
        const installed: InstalledFlowBindings = {
          organizationId: installation.organizationId,
          applicationRootId: address.application.applicationRootId,
          installationRevision: installation.applicationReleaseRevision,
          releaseKey: [
            application.releaseVersion,
            application.contentFingerprint,
            application.resolutionFingerprint,
          ].join(":"),
          bindings: application.content.flowBindings,
          flows,
          recordTypes,
          namedActions,
        };
        return installed;
      });
      return read.kind === "available" ? read.value : undefined;
    };

    /**
     * #588: the #544 continuation interface over a fresh orchestrator bound to the trusted release.
     * It re-reads the active installation and checks the caller's target against it before the
     * orchestrator consumes the single-use continuation, so Page never duplicates that validation.
     */
    const continueForm = async (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      request: FormContinuationRequest,
    ): Promise<FormContinuationOutcome> => {
      const installed = await readInstalled(session, selection);
      if (installed === undefined) return { kind: "refused", reason: "unavailable" } as const;
      const release: FlowRelease = {
        releaseKey: installed.releaseKey,
        flows: installed.flows,
        ...(installed.recordTypes === undefined ? {} : { recordTypes: installed.recordTypes }),
        ...(installed.namedActions === undefined ? {} : { namedActions: installed.namedActions }),
      };
      // The Page request adapter forwards the exact evidence unchanged; the #544 interface is the
      // only place that compares it with trusted state and consumes the single-use continuation.
      const pageFormRequests = createPageFormRequestAdapter({
        continuation: createFormContinuationService({
          orchestrator: orchestratorFor(release),
          resolveInstallation: async ({ installation, flowId, node }) => {
            // Another application is foreign, not stale: it gets the neutral refusal.
            if (
              installation.applicationRootId.toLowerCase() !==
              installed.applicationRootId.toLowerCase()
            )
              return { kind: "unavailable" };
            if (installation.installationReleaseRevision !== installed.installationRevision)
              return { kind: "stale" };
            const flow = installed.flows.get(flowId);
            if (flow === undefined) return { kind: "unavailable" };
            if (node !== undefined && !declaresPausedNode(flow, node)) return { kind: "unavailable" };
            return { kind: "current", releaseKey: installed.releaseKey };
          },
        }),
      });
      return pageFormRequests.resume(session, selection, request);
    };

    const adaptFormSubmit = createPrivateFormSubmitAdapter();
    const endpoint = createFlowBindingEndpoint({
      readInstallation: readInstalled,
      adaptFormSubmit: async (binding, callerInputs, subject) =>
        adaptFormSubmit(binding, callerInputs, subject),
      continueForm,
      orchestratorFor,
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
