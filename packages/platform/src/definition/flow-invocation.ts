import { createDetachedSegmentInvoker } from "./flow-detached-invocation";
import "server-only";

import { createHash } from "node:crypto";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { JsonValue } from "../catalogue/common";
import { recordIdSchema, type IdentityAuthorityId } from "../catalogue/identifiers";
import { describeFailure, sameId, isRecord } from "../catalogue/runtime-primitives";
import type { FlowBindingInvocation } from "../workflows/flow-invocation-contracts";
import type { ApplicationContent } from "./application-contracts";
import type { ProtectedOperationChannel } from "./application-flow-bindings";
import { canonicalJson } from "./canonical-json";
import { bindingsWithMessageActions } from "./message-action-bindings";
import type { ModuleDefinitionConsumerReadResult } from "./definition-consumer-read";
import type { PermittedApplication, PermittedApplicationsRead } from "./application-launcher-read";
import {
  createHumanOrganizationRequestService,
  type BoundHumanOrganizationRequest,
} from "../access/human-organization-request";
import { createViewerSafeRecordLinkReadService } from "../queries/viewer-safe-record-link-read";
import { adaptPrivateFormSubmit } from "../pages/form-request";
import { logRecordsTableRequestRefusal } from "../pages/records-table-features";
import {
  createRecordsTableBatchEditService,
  type RecordsTableBatchEditDependencies,
} from "../pages/records-table-features/batch-edit";
import { recordsTableBatchEditRequestSchema } from "../pages/records-table-batch-edit-request";
import { requireProjectedPlacement } from "../pages/projected-placement-gate";
import { createStoredPageCapabilityService } from "../pages/stored-page-capability";
import { recordsTableBindingRefusal } from "../pages/records-table-features/flow-dispatch";
import { createNamedActionRecordPort } from "../records/action-record-port";
import { createRecordSaveService } from "../records/save-record";
import type { createDatabaseApplicationBoundReleaseSetService } from "./application-bound-release-set";
import { readPermittedApplicationsAtAddress } from "./application-address";
import type { BackendAdapter } from "../workflows/backend-adapters";
import { installedFlowRelease } from "./flow-installed-release";
import { createFlowRunPorts, type FlowRunPortsHost } from "./flow-run-ports";
import { createFlowOrchestrator } from "./flow-orchestrator";
import type {
  FlowGuidedDraftPort,
  FlowOrchestratorDependencies,
  FlowRelease,
} from "./flow-orchestrator-types";
import { flowEntrySegmentsMatch } from "../workflows/flow-plan";
import { flowNeedsRunStart } from "../workflows/flow-run-start";
import {
  commandIdOf as flowSegmentCommandId,
  openFlowAdmissionRun,
  type FlowReceiptClaim,
} from "../workflows/start";
import {
  admitFlowPageStart,
  admitFlowSegment,
  type AdmissionHost,
} from "./flow-admission";
import { admitPageGesture } from "./flow-admission-page";
import { admitRowForm } from "./flow-row-form-admission";
import { openFlowCarriedValues, sealFlowCarriedValues } from "../workflows/flow-carried-values";
import { createInstalledContextLoader } from "./installed-page-bundle-context";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import type { ApplicationStoreService } from "./installation-application-store";
import { createViewerSafeRecordLinkService, type FlowPinTarget } from "./viewer-safe-record-link";
import type { OptionFilterKey } from "../records/option-filters";
import type { QueryContinuationKey } from "../queries/continuation-token";
import {
  createFlowBindingEndpoint,
  type InstalledFlowBindings,
  type FlowBindingEndpointResult,
} from "./flow-binding-endpoint";

/** A form field whose value is one of the options its source offers: the record a link input picks. */
type ProjectedFormField = Readonly<{
  fieldKey: string;
  placementId: string;
  recordTypes: readonly Readonly<{ moduleRootId: string; recordTypeId: string }>[];
  optionFilter?: OptionFilterKey;
}>;
type ProjectedForm = Readonly<{
  fields: ReadonlyMap<string, ProjectedFormField>;
  projectedPage?: Readonly<Record<string, unknown>>;
}>;
type GuidedControl = Readonly<{
  pageKey: string;
  pageId: string;
  flowId?: string;
  summary: boolean;
}>;

type GuidedInvocationPage = Readonly<{
  page: Readonly<Record<string, unknown>>;
  pageId: string;
  guidedForm?: Readonly<{
    draftId: string;
    revision: number;
    flowId: string;
    computedStepId: string;
    values: Readonly<Record<string, JsonValue>>;
  }>;
  subject?: Readonly<{ recordId: string; revision: number }>;
  bindings: Readonly<Record<string, readonly Readonly<{ event: string; bindingId: string }>[]>>;
}>;

export type FlowControlOptionRequest = Readonly<{
  bound: BoundHumanOrganizationRequest;
  context: InstalledRuntimeContext;
  page: Readonly<Record<string, unknown>>;
  placementId: string;
  raw: string;
  parsed: JsonValue;
  subject: Readonly<{ recordTypeId: string; recordId: string }> | undefined;
  heldValues: Readonly<Record<string, JsonValue>>;
  controls: Readonly<Record<string, string>>;
}>;

export type InvocationDependencies = Readonly<{
  boundRequest?: BoundHumanOrganizationRequest;
  authorityId: IdentityAuthorityId;
  /** The application catalogue's install and upgrade journeys, run under the initiator's authority. */
  applicationStore: ApplicationStoreService;
  /** The back-end adapter a Run on back end step hands its child flow to. */
  backend: BackendAdapter;
  channel: ProtectedOperationChannel;
  telemetry: NonNullable<Parameters<typeof createRecordSaveService>[0]["telemetry"]>;
  releaseCatalogue: Parameters<typeof createDatabaseApplicationBoundReleaseSetService>[0];
  continuationKey: QueryContinuationKey;
  /** Makes a Studio preview's link target record types readable for a pasted link title. */
  prepareLinkTargets: RecordsTableBatchEditDependencies["prepareLinkTargets"];
  validateControlOption: (input: FlowControlOptionRequest) => Promise<boolean>;
  projectRowForm: (
    bound: BoundHumanOrganizationRequest,
    context: InstalledRuntimeContext,
    page: Readonly<Record<string, unknown>>,
    pageId: string,
    formId: string,
    subject: Readonly<{ moduleRootId: string; recordTypeId: string; recordId: string }>,
  ) => Promise<
    | (ProjectedForm &
        Readonly<{
          visibleFields: ReadonlyMap<string, Readonly<{ placementId: string; kind: string }>>;
          projectedPage: Readonly<Record<string, unknown>>;
        }>)
    | undefined
  >;
  guidedFormControls: (
    page: unknown,
    shells?: unknown,
  ) => Readonly<{ all: ReadonlySet<string>; summary?: string }> | undefined;
  guidedFormFlowId: (page: unknown, bindings: unknown, shells?: unknown) => string | undefined;
  projectForm: (
    session: IdentitySession,
    request: Readonly<{
      installationRevision: number;
      releaseKey: string;
      formId: string;
      subjectRecordId?: string;
    }>,
  ) => Promise<ProjectedForm | undefined>;
  resolveFormValues: (
    args: Readonly<{
      session: IdentitySession;
      selection: OrganizationSelectionCandidate;
      application: ApplicationContent;
      modules: readonly ModuleDefinitionConsumerReadResult[];
      formId: string;
      projectedFields: ReadonlyMap<string, ProjectedFormField>;
      sequential?: boolean;
      values: unknown;
    }>,
  ) => Promise<Readonly<Record<string, JsonValue>> | undefined>;
  /** The draft steps of the guided page the request addresses, for a flow's draft tasks. */
  guidedDrafts: (
    guided: Readonly<{ pageKey: string; pageId: string }>,
    subject: Readonly<{ recordId: string }> | undefined,
    boundRequest: BoundHumanOrganizationRequest | undefined,
  ) => FlowGuidedDraftPort;
  loadGuidedPage: (
    session: IdentitySession,
    guided: GuidedControl,
    subject: Readonly<{ recordId: string }> | undefined,
  ) => Promise<GuidedInvocationPage | undefined>;
}>;

export type FlowInvocationAddress = Readonly<{
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  /**
   * The installed context this same request's own HUMAN address read authorized the application
   * against. The invocation reuses it instead of reading the installation again.
   */
  installedContext?: InstalledRuntimeContext;
}>;
export type FlowInvocationRequest = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  pageKey: string;
  /** The record the addressed page was opened for (an address candidate, never authority). */
  pageRecordId?: string | undefined;
  /** Untrusted address and declared control values; the page binding resolver validates them. */
  pageInputs: Readonly<{
    parameters: Readonly<Record<string, string | readonly string[]>>;
    controls: Readonly<Record<string, string>>;
  }>;
  invocation: FlowBindingInvocation;
}>;

/** One log line per binding refusal; the page keeps its neutral outcome. */
const logFlowRefusal = (code: string): void => {
  console.error(`[flows] invocation refused ${code}`);
};

/** A guided control shared by two pages, or a form submit anywhere but the summary form, never starts a flow. */
const refusesGuidedBinding = (guided: GuidedControl | null, event: string): boolean =>
  guided === null || (event === "form_submit" && !guided.summary);

const guidedClickId = (draftId: string, revision: number, bindingId: string): string => {
  const hex = createHash("sha256")
    .update(JSON.stringify([draftId, revision, bindingId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export async function invokeInstalledFlow(
  session: IdentitySession,
  body: FlowInvocationRequest,
  address: FlowInvocationAddress,
  dependencies: InvocationDependencies,
): Promise<FlowBindingEndpointResult> {
  const identity = { session };
  const telemetry = dependencies.telemetry;
  const authorityId = dependencies.authorityId;
  const requestDependencies = {
    identityAuthorityId: authorityId,
    telemetry,
    channel: dependencies.channel,
    ...(dependencies.boundRequest === undefined ? {} : { boundRequest: dependencies.boundRequest }),
  };
  const requests = createHumanOrganizationRequestService({
    ...requestDependencies,
  });
  const selectedRecordReader = createViewerSafeRecordLinkReadService();
  const recordPinService = createViewerSafeRecordLinkService({
    ...requestDependencies,
    permissions: dependencies.releaseCatalogue.permissions,
    createInstalledContextLoader: (transaction, scope) => {
      if (scope.applicationRootId === undefined) throw new Error("RECORD_PIN_TARGET_UNAVAILABLE");
      return createInstalledContextLoader(transaction, scope);
    },
    resolveTargetApplication: async (session, sourceSelection, applicationKey) => {
      if (
        canonicalJson(session) !== canonicalJson(identity.session) ||
        !sameId(sourceSelection.organizationId, address.read.organizationId) ||
        sourceSelection.applicationRootId === undefined ||
        !sameId(sourceSelection.applicationRootId, address.application.applicationRootId)
      )
        return undefined;
      const permitted = await readPermittedApplicationsAtAddress(
        dependencies.releaseCatalogue.permissions,
        session,
        body.tenantShortName,
        body.organizationShortName,
        authorityId,
        applicationKey,
      );
      if (
        permitted.kind !== "available" ||
        !sameId(permitted.organizationId, sourceSelection.organizationId)
      )
        return undefined;
      const targets = permitted.applications.filter((target) => target.key === applicationKey);
      const target = targets[0];
      return targets.length === 1 && target !== undefined
        ? { organizationId: permitted.organizationId, applicationRootId: target.applicationRootId }
        : undefined;
    },
  });
  const portsHost: FlowRunPortsHost = {
    requestDependencies,
    identitySession: identity.session,
    applicationKey: address.application.key,
    applicationStore: dependencies.applicationStore,
    // Save record tasks and named actions run through the record service's own
    // protected paths, under the initiator's verified request and in their own transactions.
    records: createRecordSaveService(requestDependencies),
    actionRecords: createNamedActionRecordPort(requestDependencies),
    backend: dependencies.backend,
    continuationKey: dependencies.continuationKey,
    selectedRecordReader,
    recordPinService,
  };
  /** The draft port of the guided page this request addresses; absent when it addresses none. */
  const guidedDraftsFor = (
    installation: InstalledFlowBindings,
    boundRequest: BoundHumanOrganizationRequest | undefined,
  ): Readonly<{ guidedDrafts?: FlowGuidedDraftPort }> => {
    const page = installation.applicationContent?.pages.find(
      (candidate) => candidate.key === body.pageKey && candidate.type === "guided_form",
    );
    return page === undefined
      ? {}
      : {
          guidedDrafts: dependencies.guidedDrafts(
            { pageKey: page.key, pageId: String(page.pageId) },
            body.pageRecordId === undefined ? undefined : { recordId: body.pageRecordId },
            boundRequest,
          ),
        };
  };
  const dependenciesFor = (
    release: FlowRelease,
    runId: string | undefined,
    installation: InstalledFlowBindings,
    boundRequest?: BoundHumanOrganizationRequest,
    pin?: Readonly<{ target: FlowPinTarget; storedTargetResume: boolean }>,
    receipt?: FlowReceiptClaim,
  ): FlowOrchestratorDependencies => {
    const admissionHost: AdmissionHost = {
      requests: requestDependencies,
      continuationKey: dependencies.continuationKey,
      invocation,
      ...(dependencies.boundRequest === undefined || address.installedContext === undefined
        ? {}
        : {
            boundContext: { request: dependencies.boundRequest, context: address.installedContext },
          }),
      installationOf: installedFlowBindings,
      pageAccess: async (context, bound) => {
        // An authored binding or one derived from it for a message's action (Undo).
        const installed = installedFlowBindings(context);
        const binding =
          invocation.kind === "binding"
            ? bindingsWithMessageActions(installed.bindings, [...installed.flows.values()]).find(
                (candidate) => sameId(candidate.bindingId, invocation.bindingId),
              )
            : undefined;
        if (invocation.kind === "binding" && binding === undefined) return false;
        return gateBindingToAddressedPage(context, binding?.controlId, bound);
      },
      pageGate: async (context, binding, bound, currentInstallation, state) => {
        if (!(await gateBindingToAddressedPage(context, binding.controlId, bound))) return false;
        const page = admittedProjection?.page;
        if (page === undefined) return false;
        const guided = guidedControls.get(binding.controlId.toLowerCase());
        if (guided !== undefined && refusesGuidedBinding(guided, binding.event)) return false;
        return admitPageGesture(
          {
            validateOption: dependencies.validateControlOption,
            projectRowForm: (rowBound, rowContext, rowPage, tableId, formId, recordId) =>
              admitRowForm(
                dependencies,
                requestDependencies,
                rowBound,
                rowContext,
                rowPage,
                body,
                binding,
                state,
                tableId,
                formId,
                recordId,
              ),
          },
          bound,
          context,
          currentInstallation,
          page,
          body,
          binding,
          state,
        );
      },
      bindPin: (bound, input) => recordPinService.bindFlowPinInRequest(bound.transaction, input),
      portsFor: dependenciesFor,
    };
    return {
      ...createFlowRunPorts(
        portsHost,
        release,
        runId,
        installation,
        {
          admitSegment: (run, state, segment, execute, entry) =>
            admitFlowSegment(admissionHost, installation, run, state, segment, execute, entry),
          admitPageStart: (run, state) =>
            admitFlowPageStart(admissionHost, installation, run, state),
        },
        boundRequest,
        pin,
        receipt,
      ),
      ...guidedDraftsFor(installation, boundRequest),
    };
  };
  const orchestratorFor = (
    release: FlowRelease,
    runId: string | undefined,
    installation: InstalledFlowBindings,
  ) => createFlowOrchestrator(dependenciesFor(release, runId, installation));

  const guidedControls = new Map<
    string,
    Readonly<{
      pageKey: string;
      pageId: string;
      flowId?: string;
      summary: boolean;
    }> | null
  >();

  /** The flow bindings, flows and record types of one trusted installed context. */
  const installedFlowBindings = (installation: InstalledRuntimeContext): InstalledFlowBindings => {
    const application = installation.releaseSet.application;
    guidedControls.clear();
    for (const page of application.content.pages) {
      if (page.type !== "guided_form") continue;
      const controls = dependencies.guidedFormControls(page, application.content.shells);
      if (controls === undefined) throw new Error("INVALID_GUIDED_FORM_CONTROLS");
      const flowId = dependencies.guidedFormFlowId(
        page,
        application.content.flowBindings,
        application.content.shells,
      );
      for (const controlId of controls.all) {
        const key = controlId.toLowerCase();
        guidedControls.set(
          key,
          guidedControls.has(key)
            ? null
            : {
                pageKey: page.key,
                pageId: String(page.pageId),
                ...(flowId === undefined ? {} : { flowId }),
                summary: key === controls.summary,
              },
        );
      }
    }
    const installed = installedFlowRelease(installation);
    return installed;
  };

  /** The trusted active installed context for the initiator's own selection; never from the request. */
  const readInstalledContext = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
  ): Promise<InstalledRuntimeContext | undefined> => {
    // The address resolution of this same request already read the installed context under the
    // person's own verified scope for exactly this organisation and application; it is reused, so
    // the request does not decide the same access twice. The next request reads again.
    const carried = address.installedContext;
    if (
      carried !== undefined &&
      selection.applicationRootId !== undefined &&
      sameId(carried.organizationId, selection.organizationId) &&
      sameId(carried.applicationRootId, selection.applicationRootId)
    )
      return carried;
    const read = await requests.run(session, selection, async (transaction, scope) => {
      if (scope.applicationRootId === undefined)
        throw new Error("INSTALLED_FLOW_BINDINGS_SCOPE_UNAVAILABLE");
      return createInstalledContextLoader(transaction, scope).load();
    });
    return read.kind === "available" ? read.value : undefined;
  };

  /** The flow bindings of the trusted active installation for the initiator's own selection. */
  const invocation = body.invocation;
  let admittedProjection:
    | Readonly<{
        accessVersion: BoundHumanOrganizationRequest["scope"]["accessVersion"];
        installationRevision: number;
        page: Readonly<Record<string, unknown>>;
      }>
    | undefined;
  /**
   * Projects the addressed page for this person and requires the control on it, once and usable.
   * The client only learns that the invocation is refused; the cause is logged.
   */
  const gateBindingToAddressedPage = async (
    context: InstalledRuntimeContext,
    controlId: string | undefined,
    bound: BoundHumanOrganizationRequest,
  ): Promise<boolean> => {
    const page = context.releaseSet.application.content.pages.find(
      (candidate) => candidate.key === body.pageKey,
    );
    if (page === undefined) {
      logFlowRefusal("BINDING_CONTROL_NOT_ON_PAGE page_not_installed");
      return false;
    }
    const capability = createStoredPageCapabilityService({
      ...requestDependencies,
      context,
      permissions: dependencies.releaseCatalogue.permissions,
      // The page's own record decides its record-based visibility conditions and action
      // availability; a gesture's subject (a row of a table on the page) never stands in for it.
      selection: {
        pageId: String(page.pageId),
        ...(body.pageRecordId === undefined ? {} : { subjectRecordId: body.pageRecordId }),
      },
    });
    if (
      admittedProjection !== undefined &&
      (admittedProjection.accessVersion !== bound.scope.accessVersion ||
        admittedProjection.installationRevision !== context.applicationReleaseRevision)
    ) {
      logFlowRefusal("BINDING_PROJECTION_CONTEXT_CHANGED");
      return false;
    }
    const projected =
      admittedProjection?.page ??
      (await capability.projectInTransaction(bound.transaction, bound.scope));
    if (projected === undefined) {
      logFlowRefusal("BINDING_CONTROL_NOT_ON_PAGE page_projection_unavailable");
      return false;
    }
    if (admittedProjection === undefined)
      admittedProjection = {
        accessVersion: bound.scope.accessVersion,
        installationRevision: context.applicationReleaseRevision,
        page: projected,
      };
    // A binding of the page itself (load, record_loaded) is on the page the person is addressing.
    if (controlId === undefined || sameId(controlId, String(page.pageId))) return true;
    const gate = requireProjectedPlacement(projected, controlId);
    if (gate.kind === "refused") {
      logFlowRefusal(`BINDING_CONTROL_NOT_ON_PAGE ${gate.reason}`);
      return false;
    }
    return true;
  };
  const selection = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
    ...(address.application.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: address.application.previewInstallationId }),
  };
  // Use the same installed snapshot for this gate and the endpoint. A crafted action on a
  // guided page must not start a flow before its final form submit is confirmed.
  const bindingContext = await readInstalledContext(identity.session, selection);
  const bindingInstallation =
    bindingContext === undefined ? undefined : installedFlowBindings(bindingContext);
  if (invocation.kind === "binding") {
    if (bindingContext === undefined || bindingInstallation === undefined) {
      logFlowRefusal("BINDING_INSTALLATION_NOT_CURRENT");
      return { kind: "refused", committedNow: false };
    }
    const plan = bindingInstallation.plans.get(String(invocation.flowId));
    const segment = plan?.segments.find(
      (part) => part.kind === "server" && part.id === invocation.segment.segmentId,
    );
    if (segment === undefined || segment.kind !== "server")
      return { kind: "refused", committedNow: false };
    try {
      openFlowCarriedValues(
        invocation.carriedValues,
        dependencies.continuationKey,
        {
          flowId: String(invocation.flowId),
          bindingId: String(invocation.bindingId),
          identityId: identity.session.identityId,
          organizationId: selection.organizationId,
          applicationRootId: selection.applicationRootId,
        },
        segment,
      );
    } catch (error) {
      logFlowRefusal(`BINDING_CARRIED_VALUES_INVALID ${describeFailure(error)}`);
      return { kind: "refused", committedNow: false };
    }
    const binding = bindingsWithMessageActions(bindingInstallation.bindings, [
      ...bindingInstallation.flows.values(),
    ]).find(
      (candidate) => candidate.bindingId.toLowerCase() === invocation.bindingId.toLowerCase(),
    );
    const guided =
      binding === undefined ? undefined : guidedControls.get(binding.controlId.toLowerCase());
    if (
      guided !== undefined &&
      binding !== undefined &&
      refusesGuidedBinding(guided, binding.event)
    ) {
      logFlowRefusal("BINDING_GUIDED_CONTROL_NOT_CONFIRMED");
      return { kind: "refused", committedNow: false };
    }
    // A Records table row, bulk or inline-edit command runs only for a command the installed
    // placement declares (a grid feature only while it is on) and rows the viewer may use now.
    const featureRefusal =
      binding === undefined
        ? undefined
        : await recordsTableBindingRefusal(
            bindingInstallation,
            binding,
            invocation.callerInputs ?? {},
            invocation.subject,
            (operation) => requests.run(identity.session, selection, operation),
          );
    if (featureRefusal !== undefined) {
      logRecordsTableRequestRefusal(featureRefusal, "flow_dispatch");
      // A row shown at another revision than the stored one: the person reloads and sees the
      // fresh row, rather than a neutral refusal.
      if (
        featureRefusal.reason === "displayed_revision_not_current" &&
        bindingContext !== undefined
      )
        return {
          kind: "reload",
          installationRevision: bindingContext.applicationReleaseRevision,
          committedNow: false,
        };
      logFlowRefusal("BINDING_GRID_FEATURE_NOT_PROJECTED");
      return { kind: "refused", committedNow: false };
    }
  }

  const endpoint = createFlowBindingEndpoint({
    readInstallation: async () => bindingInstallation,
    openRun: async (session, selection, binding, installation, request) => {
      const plan = installation.plans?.get(String(binding.flow.flowId));
      if (
        plan === undefined ||
        !flowEntrySegmentsMatch(plan, request.entrySegments) ||
        !flowNeedsRunStart(plan.segments)
      )
        return { kind: "reload", installationRevision: installation.installationRevision };
      const release: FlowRelease = {
        releaseKey: installation.releaseKey,
        installationRevision: installation.installationRevision,
        flows: installation.flows,
        plans: installation.plans!,
      };
      const opened = await openFlowAdmissionRun(
        {
          requests: requestDependencies,
          authorizeBinding: async (bound) => {
            if (bound.scope.applicationRootId === undefined) return false;
            const current = await createInstalledContextLoader(
              bound.transaction,
              bound.scope,
            ).load();
            const currentBinding = current.releaseSet.application.content.flowBindings.filter(
              (entry) => sameId(entry.bindingId, binding.bindingId),
            );
            if (
              current.applicationReleaseRevision !== installation.installationRevision ||
              currentBinding.length !== 1 ||
              canonicalJson(currentBinding[0]) !== canonicalJson(binding)
            )
              return false;
            return gateBindingToAddressedPage(current, binding.controlId, bound);
          },
          authorizeInvocation: async (bound) =>
            (await dependenciesFor(release, undefined, installation, bound).authorizeInvocation?.(
              session,
              selection,
              plan.definition,
            )) === true,
        },
        { session, selection, plan, bindingId: String(binding.bindingId) },
      );
      if (opened.kind !== "opened" || selection.applicationRootId === undefined)
        return { kind: "refused" };
      const carriedValues = sealFlowCarriedValues(
        {},
        {},
        dependencies.continuationKey,
        {
          flowId: String(binding.flow.flowId),
          bindingId: String(binding.bindingId),
          runId: opened.runId,
          identityId: session.identityId,
          organizationId: selection.organizationId,
          applicationRootId: selection.applicationRootId,
        },
        undefined,
        true,
      );
      if (carriedValues === undefined) throw new Error("FLOW_RUN_TOKEN_UNAVAILABLE");
      return { kind: "run_opened", carriedValues };
    },
    adaptBatchEdit: async (binding, callerInputs, installation) => {
      const request = recordsTableBatchEditRequestSchema.safeParse({
        placementId: String(binding.controlId),
        operation: callerInputs.operation,
        rows: callerInputs.rows,
      });
      if (!request.success) {
        logFlowRefusal("BINDING_BATCH_EDIT_ROWS_INVALID");
        return undefined;
      }
      const prepared = await createRecordsTableBatchEditService({
        ...requestDependencies,
        continuationKey: dependencies.continuationKey,
        prepareLinkTargets: dependencies.prepareLinkTargets,
      }).prepare(
        identity.session,
        { pageId: body.pageKey, selection, installedContext: bindingContext! },
        request.data,
      );
      if (prepared.kind === "cells_refused") return prepared;
      if (prepared.kind !== "ready") {
        logFlowRefusal(`BINDING_BATCH_EDIT_${prepared.kind.toUpperCase()}`);
        return undefined;
      }
      void installation;
      return {
        kind: "adapted",
        inputs: { rows: prepared.rows, operation: request.data.operation },
      };
    },
    adaptFormSubmit: async (binding, callerInputs, subject, installation) => {
      const resolveValues = async (values: unknown) => {
        if (installation.applicationContent === undefined || installation.modules === undefined)
          return undefined;
        const projectedForm = await dependencies.projectForm(identity.session, {
          installationRevision: installation.installationRevision,
          releaseKey: installation.releaseKey,
          formId: binding.controlId,
          ...(subject === undefined ? {} : { subjectRecordId: subject.recordId }),
        });
        if (projectedForm === undefined) return undefined;
        if (
          dependencies.boundRequest !== undefined &&
          projectedForm.projectedPage !== undefined &&
          subject?.recordId === body.pageRecordId &&
          admittedProjection === undefined
        )
          admittedProjection = {
            accessVersion: dependencies.boundRequest.scope.accessVersion,
            installationRevision: installation.installationRevision,
            page: projectedForm.projectedPage,
          };
        const resolvedValues = await dependencies.resolveFormValues({
          session: identity.session,
          selection,
          application: installation.applicationContent,
          modules: installation.modules,
          formId: binding.controlId,
          projectedFields: projectedForm.fields,
          ...(dependencies.boundRequest === undefined ? {} : { sequential: true }),
          values,
        });
        return resolvedValues === undefined
          ? undefined
          : { fields: projectedForm.fields, values: resolvedValues };
      };
      const adaptSelectedReadInputs = (
        adaptedInputs: Readonly<Record<string, unknown>>,
        resolved: NonNullable<Awaited<ReturnType<typeof resolveValues>>>,
      ): Readonly<Record<string, unknown>> | undefined => {
        const selectedReadInputs = installation.selectedRecordReadInputs?.get(
          String(binding.flow.flowId).toLowerCase(),
        );
        if (selectedReadInputs === undefined || selectedReadInputs.size === 0) return adaptedInputs;

        const result: Record<string, unknown> = { ...adaptedInputs };
        const selectedCallerNames = new Set<string>();
        for (const [flowInputName, declaredRecordTypeId] of selectedReadInputs) {
          const flowInput = binding.flow.inputs[flowInputName];
          if (
            !isRecord(flowInput) ||
            flowInput.kind !== "caller" ||
            typeof flowInput.name !== "string"
          )
            return undefined;
          const callerInputName = flowInput.name;
          const matchingCallerInputs = Object.values(binding.flow.inputs).filter(
            (candidate) =>
              isRecord(candidate) &&
              candidate.kind === "caller" &&
              candidate.name === callerInputName,
          );
          if (
            matchingCallerInputs.length !== 1 ||
            selectedCallerNames.has(callerInputName) ||
            !Object.hasOwn(adaptedInputs, callerInputName)
          )
            return undefined;
          selectedCallerNames.add(callerInputName);

          const choiceField = resolved.fields.get(callerInputName);
          if (choiceField === undefined || choiceField.recordTypes.length !== 1) return undefined;
          const choiceRecordType = choiceField.recordTypes[0];
          const selectedReadModule = installation.selectedRecordReadModules?.get(
            declaredRecordTypeId.toLowerCase(),
          );
          if (
            choiceRecordType === undefined ||
            !sameId(choiceRecordType.recordTypeId, declaredRecordTypeId) ||
            selectedReadModule === undefined ||
            !sameId(choiceRecordType.moduleRootId, selectedReadModule.moduleRootId)
          )
            return undefined;

          const selectedValue = resolved.values[callerInputName];
          if (
            !isRecord(selectedValue) ||
            Object.keys(selectedValue).length !== 2 ||
            !Object.hasOwn(selectedValue, "recordTypeId") ||
            !Object.hasOwn(selectedValue, "recordId") ||
            typeof selectedValue.recordTypeId !== "string" ||
            !sameId(selectedValue.recordTypeId, choiceRecordType.recordTypeId) ||
            adaptedInputs[callerInputName] !== selectedValue
          )
            return undefined;
          const recordId = recordIdSchema.safeParse(selectedValue.recordId);
          if (!recordId.success) return undefined;
          result[callerInputName] = {
            recordTypeId: choiceRecordType.recordTypeId,
            recordId: recordId.data,
          };
        }
        return result;
      };
      const guided = guidedControls.get(binding.controlId.toLowerCase());
      if (guided === undefined) {
        if (Object.hasOwn(callerInputs, "draft")) return undefined;
        const resolved = await resolveValues(callerInputs.values);
        if (resolved === undefined) return undefined;
        const adaptedInputs = adaptPrivateFormSubmit(
          binding,
          { ...callerInputs, values: resolved.values },
          subject,
        );
        return adaptedInputs === undefined
          ? undefined
          : adaptSelectedReadInputs(adaptedInputs, resolved);
      }
      if (
        guided === null ||
        !guided.summary ||
        guided.flowId === undefined ||
        guided.flowId.toLowerCase() !== String(binding.flow.flowId).toLowerCase()
      )
        return undefined;
      const named = callerInputs.draft;
      if (
        !isRecord(named) ||
        Object.keys(named).length !== 2 ||
        typeof named.draftId !== "string" ||
        typeof named.revision !== "number" ||
        !isRecord(callerInputs.values) ||
        Object.keys(callerInputs.values).length !== 0
      )
        return undefined;
      // The submit takes its answers only from the caller's own stored draft at the revision it
      // names: the draft is read for this session, so another person's draft is never found.
      const model = await dependencies.loadGuidedPage(identity.session, guided, subject);
      const draft = model?.guidedForm;
      /** The retry of a submit whose reply was lost: its draft is gone, its stored outcome remains. */
      const replaysCompletedSubmit = async (): Promise<boolean> => {
        if (invocation.kind !== "binding" || invocation.segment === undefined) return false;
        const commandId = flowSegmentCommandId(
          identity.session,
          selection,
          guidedClickId(
            named.draftId as string,
            named.revision as number,
            String(binding.bindingId),
          ),
          invocation.segment.segmentId,
          "0",
        );
        const found = await requests.run(identity.session, selection, async (transaction) => {
          const rows =
            await transaction.query`select vortex_record.flow_segment_receipt(${commandId}::uuid, true) as result`;
          return isRecord(rows[0]?.result) && rows[0].result.status === "completed";
        });
        return found.kind === "available" && found.value === true;
      };
      const summary = Array.isArray(model?.page.steps)
        ? model.page.steps.find((step) => isRecord(step) && step.summary === true)
        : undefined;
      const draftIsCurrent = !(
        model === undefined ||
        draft === undefined ||
        !isRecord(summary) ||
        typeof summary.id !== "string" ||
        guided.flowId === undefined ||
        String(model.pageId).toLowerCase() !== guided.pageId.toLowerCase() ||
        draft.computedStepId !== summary.id ||
        draft.draftId.toLowerCase() !== named.draftId.toLowerCase() ||
        draft.revision !== named.revision ||
        draft.flowId.toLowerCase() !== guided.flowId.toLowerCase() ||
        (model.subject?.recordId.toLowerCase() ?? null) !==
          (subject?.recordId.toLowerCase() ?? null) ||
        (subject !== undefined && model.subject?.revision !== subject.revision) ||
        !(model.bindings[binding.controlId] ?? []).some(
          (held) =>
            held.event === "form_submit" &&
            held.bindingId.toLowerCase() === String(binding.bindingId).toLowerCase(),
        )
      );
      if (!draftIsCurrent) {
        if (!(await replaysCompletedSubmit())) return undefined;
        // Only the stored outcome is replayed; the answers of a draft that is gone are never read.
        return adaptPrivateFormSubmit(
          binding,
          {
            values: {},
            draft: { draftId: named.draftId, revision: named.revision },
            ...(callerInputs.selectedOwnerGroupId === undefined
              ? {}
              : { selectedOwnerGroupId: callerInputs.selectedOwnerGroupId }),
          },
          subject,
        );
      }
      if (model === undefined || draft === undefined) return undefined;
      const resolved = await resolveValues(draft.values);
      if (resolved === undefined) return undefined;
      const adaptedInputs = adaptPrivateFormSubmit(
        binding,
        {
          values: resolved.values,
          draft: { draftId: draft.draftId, revision: draft.revision },
          ...(callerInputs.selectedOwnerGroupId === undefined
            ? {}
            : { selectedOwnerGroupId: callerInputs.selectedOwnerGroupId }),
        },
        subject,
      );
      return adaptedInputs === undefined
        ? undefined
        : adaptSelectedReadInputs(adaptedInputs, resolved);
    },
    invokeSegment: createDetachedSegmentInvoker(dependencies.continuationKey, orchestratorFor),
  });

  const namedDraft =
    invocation.kind === "binding" && isRecord(invocation.callerInputs?.draft)
      ? invocation.callerInputs.draft
      : undefined;
  const invocationWithStableClick =
    invocation.kind === "binding" &&
    typeof namedDraft?.draftId === "string" &&
    typeof namedDraft.revision === "number"
      ? {
          ...invocation,
          clickId: guidedClickId(namedDraft.draftId, namedDraft.revision, invocation.bindingId),
        }
      : invocation;
  const result = await endpoint.invoke(identity.session, selection, invocationWithStableClick);
  return result;
}
