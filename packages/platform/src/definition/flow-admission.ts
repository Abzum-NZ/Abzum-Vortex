import "server-only";

import type {
  BoundHumanOrganizationRequest,
  HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import { describeFailure, isRecord, sameId } from "../catalogue/runtime-primitives";
import { continueFlowRun } from "../rules/flow-interpreter";
import {
  browserFlowMemberTypeResolver,
  pageFlowGuardMatches,
} from "../rules/flow-page-output-state";
import { iterationKey } from "../rules/flow-interpreter-state";
import type { FlowBindingInvocation } from "../workflows/flow-invocation-contracts";
import { startFlow, type FlowReceiptClaim } from "../workflows/start";
import {
  viewerSafeRecordPinSelectorSchema,
  type ViewerSafeRecordPinSelector,
} from "../records/record-links";
import { carriesSensitive } from "./flow-orchestrator-support";
import type { FlowPinTarget } from "./viewer-safe-record-link";
import { openFlowCarriedValues } from "../workflows/flow-carried-values";
import type { QueryContinuationKey } from "../queries/continuation-token";
import { canonicalJson } from "./canonical-json";
import { bindingsWithMessageActions } from "./message-action-bindings";
import { createInstalledContextLoader } from "./installed-page-bundle-context";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowOrchestratorDependencies, FlowRelease, Run } from "./flow-orchestrator-types";
import type { ComponentFlowBinding } from "./application-flow-bindings";
import type { FlowRunState } from "../rules/flow-interpreter";

export type AdmissionHost = Readonly<{
  requests: HumanOrganizationRequestDependencies;
  continuationKey: QueryContinuationKey;
  invocation: FlowBindingInvocation;
  boundContext?: Readonly<{
    request: BoundHumanOrganizationRequest;
    context: InstalledRuntimeContext;
  }>;
  installationOf: (context: InstalledRuntimeContext) => InstalledFlowBindings;
  pageAccess: (
    context: InstalledRuntimeContext,
    bound: BoundHumanOrganizationRequest,
  ) => Promise<boolean>;
  pageGate: (
    context: InstalledRuntimeContext,
    binding: ComponentFlowBinding,
    bound: BoundHumanOrganizationRequest,
    installation: InstalledFlowBindings,
    state: FlowRunState,
  ) => Promise<boolean>;
  bindPin: (
    bound: BoundHumanOrganizationRequest,
    input: Readonly<{
      commandId: string;
      runId: string;
      taskPath: string;
      iteration: string;
      selector: ViewerSafeRecordPinSelector;
      replay: boolean;
    }>,
  ) => Promise<FlowPinTarget | undefined>;
  portsFor: (
    release: FlowRelease,
    runId: string,
    installation: InstalledFlowBindings,
    bound?: BoundHumanOrganizationRequest,
    pin?: Readonly<{ target: FlowPinTarget; storedTargetResume: boolean }>,
    receipt?: FlowReceiptClaim,
  ) => FlowOrchestratorDependencies;
}>;

/** Shares the current binding, page and flow checks for every admission shape. */
const prepareAdmission = (
  host: AdmissionHost,
  installation: InstalledFlowBindings,
  run: Run,
  state: FlowRunState,
) => {
  const capturedBinding = bindingsWithMessageActions(installation.bindings, [
    ...installation.flows.values(),
  ]).find((entry) => sameId(entry.bindingId, run.bindingId));
  if (capturedBinding === undefined || !sameId(capturedBinding.flow.flowId, run.flowId))
    return undefined;
  const selection = run.authority.selection;
  if (selection.applicationRootId === undefined) return undefined;
  let currentInstallation: InstalledFlowBindings | undefined;
  let currentRelease: FlowRelease | undefined;
  let currentContext: InstalledRuntimeContext | undefined;
  return {
    authorizeBinding: async (bound: BoundHumanOrganizationRequest) => {
      if (bound.scope.applicationRootId === undefined) return false;
      const captured = host.boundContext;
      const current =
        captured !== undefined &&
        sameId(captured.request.scope.organizationId, bound.scope.organizationId) &&
        captured.request.scope.applicationRootId !== undefined &&
        bound.scope.applicationRootId !== undefined &&
        sameId(captured.request.scope.applicationRootId, bound.scope.applicationRootId) &&
        captured.request.scope.accessVersion === bound.scope.accessVersion
          ? captured.context
          : await createInstalledContextLoader(bound.transaction, bound.scope).load();
      currentContext = current;
      currentInstallation = host.installationOf(current);
      const matches = bindingsWithMessageActions(currentInstallation.bindings, [
        ...currentInstallation.flows.values(),
      ]).filter((entry) => sameId(entry.bindingId, run.bindingId));
      if (matches.length !== 1 || canonicalJson(matches[0]) !== canonicalJson(capturedBinding))
        return false;
      currentRelease = {
        releaseKey: currentInstallation.releaseKey,
        installationRevision: currentInstallation.installationRevision,
        flows: currentInstallation.flows,
        plans: currentInstallation.plans,
        ...(currentInstallation.recordTypes === undefined
          ? {}
          : { recordTypes: currentInstallation.recordTypes }),
        ...(currentInstallation.namedActions === undefined
          ? {}
          : { namedActions: currentInstallation.namedActions }),
        ...(currentInstallation.selectedRecordReadProjections === undefined
          ? {}
          : { selectedRecordReadProjections: currentInstallation.selectedRecordReadProjections }),
      };
      return host.pageAccess(current, bound);
    },
    authorizeGesture: async (bound: BoundHumanOrganizationRequest) =>
      currentContext !== undefined &&
      currentInstallation !== undefined &&
      host.pageGate(currentContext, capturedBinding, bound, currentInstallation, state),
    currentPlan: async () => {
      const currentPlan = currentInstallation?.plans.get(run.flowId);
      return currentPlan === undefined || currentInstallation === undefined
        ? undefined
        : { plan: currentPlan, installationRevision: currentInstallation.installationRevision };
    },
    authorizeInvocation: async (bound: BoundHumanOrganizationRequest) => {
      if (currentRelease === undefined || currentInstallation === undefined) return false;
      const flow = currentRelease.flows.get(run.flowId);
      return (
        flow !== undefined &&
        (await host
          .portsFor(currentRelease, state.runId, currentInstallation, bound)
          .authorizeInvocation?.(run.authority.session, selection, flow)) === true
      );
    },
    ports: (
      bound?: BoundHumanOrganizationRequest,
      pin?: Readonly<{ target: FlowPinTarget; storedTargetResume: boolean }>,
      receipt?: FlowReceiptClaim,
    ) => {
      if (currentRelease === undefined || currentInstallation === undefined)
        throw new Error("FLOW_ADMISSION_CONTEXT_UNAVAILABLE");
      return host.portsFor(currentRelease, state.runId, currentInstallation, bound, pin, receipt);
    },
  };
};

/** Admits a continuation whose answer reaches no further server segment. */
export const admitFlowContinuation = async (
  host: AdmissionHost,
  installation: InstalledFlowBindings,
  ...args: Parameters<FlowOrchestratorDependencies["admitContinuation"]>
): ReturnType<FlowOrchestratorDependencies["admitContinuation"]> => {
  const [run, state, execute, openReplay] = args;
  const admission = prepareAdmission(host, installation, run, state);
  const plan = run.release.plans.get(run.flowId);
  if (
    admission === undefined ||
    plan === undefined ||
    run.pendingContinuation === undefined ||
    run.continuationPlan === undefined
  )
    return { kind: "refused", committedNow: false };
  return startFlow(
    {
      requests: host.requests,
      authorizeBinding: admission.authorizeBinding,
      authorizeGesture: admission.authorizeGesture,
      currentPlan: admission.currentPlan,
      authorizeInvocation: admission.authorizeInvocation,
      execute: async () => {
        throw new Error("FLOW_CONTINUATION_SEGMENT_UNEXPECTED");
      },
      executeContinuation: execute,
      openContinuationReplay: openReplay,
    },
    {
      session: run.authority.session,
      selection: run.authority.selection,
      plan,
      expected: null,
      gestureId: run.gestureId,
      runId: state.runId,
      bindingId: run.bindingId,
      iteration: iterationKey(state),
      continuation: run.pendingContinuation,
      continuationPlan: run.continuationPlan,
    },
  );
};

/** Admits a start that reaches a page intent or completion before a server segment. */
export const admitFlowPageStart = async (
  host: AdmissionHost,
  installation: InstalledFlowBindings,
  run: Run,
  state: FlowRunState,
) => {
  const admission = prepareAdmission(host, installation, run, state);
  const plan = run.release.plans.get(run.flowId);
  if (admission === undefined || plan === undefined || host.invocation.kind !== "binding")
    return { kind: "refused", committedNow: false } as const;
  return startFlow(
    {
      requests: host.requests,
      authorizeBinding: admission.authorizeBinding,
      authorizeGesture: admission.authorizeGesture,
      currentPlan: admission.currentPlan,
      authorizeInvocation: admission.authorizeInvocation,
      execute: async () => ({ value: null, outcome: "succeeded", effects: {}, warnings: {} }),
    },
    {
      session: run.authority.session,
      selection: run.authority.selection,
      plan,
      expected: null,
      entrySegments: host.invocation.entrySegments,
      gestureId: run.gestureId,
      runId: state.runId,
      bindingId: run.bindingId,
      iteration: iterationKey(state),
    },
  );
};

/** Resolves the current binding and plan inside the transaction admitting this segment. */
export const admitFlowSegment = async (
  host: AdmissionHost,
  installation: InstalledFlowBindings,
  ...args: Parameters<FlowOrchestratorDependencies["admitSegment"]>
): ReturnType<FlowOrchestratorDependencies["admitSegment"]> => {
  const [run, state, segment, execute, entry] = args;
  const admission = prepareAdmission(host, installation, run, state);
  if (admission === undefined) return { kind: "refused", committedNow: false };
  const selection = run.authority.selection;
  const first =
    segment.preScopeLock === "organization_account"
      ? (entry ?? continueFlowRun(state, run.library, segment))
      : undefined;
  const inputs = first?.kind === "protected_task" ? first.call.properties.inputs?.value : undefined;
  const profileAccountId = isRecord(inputs)
    ? inputs.organization_account_id
    : first?.kind === "protected_task"
      ? first.call.flowInputs.organization_account_id?.value
      : undefined;
  const plan = run.release.plans.get(run.flowId);
  if (plan === undefined) return { kind: "refused", committedNow: false };
  const detached = host.invocation.kind === "binding" ? host.invocation.segment : undefined;
  if (detached !== undefined && detached.segmentId !== segment.id)
    return { kind: "refused", committedNow: false };
  if (detached !== undefined && host.invocation.kind === "binding" && segment.section !== "tasks") {
    if (selection.applicationRootId === undefined) return { kind: "refused", committedNow: false };
    let failure: Readonly<{ segmentId: string }> | undefined;
    try {
      failure = openFlowCarriedValues(
        host.invocation.carriedValues,
        host.continuationKey,
        {
          flowId: run.flowId,
          bindingId: run.bindingId,
          identityId: run.authority.session.identityId,
          organizationId: selection.organizationId,
          applicationRootId: selection.applicationRootId,
        },
        segment,
      ).failure;
    } catch (error) {
      console.error(`[flows] invalid phase evidence: ${describeFailure(error)}`);
      return { kind: "refused", committedNow: false };
    }
    const index = plan.segments.findIndex((part) => part.id === segment.id);
    const serverFailure =
      failure !== undefined &&
      plan.segments
        .slice(0, index)
        .some((part) => part.kind === "server" && part.id === failure?.segmentId);
    let pageFailure = false;
    if (host.invocation.phase === "page_failure") {
      try {
        const resolveMember = browserFlowMemberTypeResolver(plan.browser);
        pageFailure = plan.segments.slice(0, index).some((part) => {
          if (part.kind !== "page" || part.section === "finally" || part.tasks.length === 0)
            return false;
          try {
            return pageFlowGuardMatches(part.guard, state, plan.definition, resolveMember);
          } catch (error) {
            console.error(
              `[flows] page failure guard could not be evaluated: ${describeFailure(error)}`,
            );
            return false;
          }
        });
      } catch (error) {
        console.error(`[flows] invalid page failure path: ${describeFailure(error)}`);
        return { kind: "refused", committedNow: false };
      }
    }
    if (segment.tasks.length === 0 && (serverFailure || pageFailure))
      return { kind: "refused", committedNow: false };
    if (segment.section === "errors" && !serverFailure && !pageFailure)
      return { kind: "refused", committedNow: false };
    if (
      segment.section === "finally" &&
      !serverFailure &&
      !pageFailure &&
      host.invocation.phase !== "success"
    )
      return { kind: "refused", committedNow: false };
    if (failure !== undefined && !serverFailure) return { kind: "refused", committedNow: false };
  }
  const expectedFingerprint =
    detached !== undefined
      ? detached.fingerprint
      : run.pendingContinuation === undefined
        ? segment.fingerprint
        : run.continuationSegments?.[segment.id];
  if (expectedFingerprint === undefined) return { kind: "reload", committedNow: false };
  return startFlow(
    {
      requests: host.requests,
      authorizeBinding: admission.authorizeBinding,
      authorizeGesture: admission.authorizeGesture,
      currentPlan: admission.currentPlan,
      authorizeInvocation: admission.authorizeInvocation,
      execute: async (bound, _part, replay) => {
        return execute(admission.ports(bound), replay);
      },
      prepareWorkflow: async (bound, part, commandId, runId, resumed, replay) => {
        const first = entry ?? continueFlowRun(state, run.library, part);
        if (first.kind !== "protected_task" || first.call.taskType !== "record.pin_identity")
          return { kind: "ready" };
        const call = first.call;
        if (
          call.taskVersion !== "1.0.0" ||
          Object.keys(call.properties).length !== 3 ||
          call.properties.application_key?.type !== "text" ||
          call.properties.record_type_key?.type !== "text" ||
          call.properties.record_id?.type !== "text"
        )
          return { kind: "refused" };
        const selector = viewerSafeRecordPinSelectorSchema.safeParse({
          applicationKey: call.properties.application_key.value,
          recordTypeKey: call.properties.record_type_key.value,
          recordId: call.properties.record_id.value,
        });
        if (!selector.success || carriesSensitive(selector.data, run.sensitive))
          return { kind: "refused" };
        const target = await host.bindPin(bound, {
          commandId,
          runId,
          taskPath: call.taskPath,
          iteration: call.iteration,
          selector: selector.data,
          replay,
        });
        return target === undefined
          ? { kind: "refused" }
          : { kind: "ready", value: { target, storedTargetResume: resumed } };
      },
      executeWorkflow: async (replay, prepared, receipt) =>
        execute(
          admission.ports(
            undefined,
            prepared as
              Readonly<{ target: FlowPinTarget; storedTargetResume: boolean }> | undefined,
            receipt,
          ),
          replay,
        ),
    },
    {
      session: run.authority.session,
      selection,
      plan,
      expected: { segmentId: segment.id, fingerprint: expectedFingerprint },
      ...(host.invocation.kind === "binding"
        ? { entrySegments: host.invocation.entrySegments }
        : {}),
      gestureId: run.gestureId,
      ...(detached !== undefined &&
      segment.tasks.length === 0 &&
      plan.segments.filter((part) => part.kind === "server").length === 1 &&
      host.invocation.kind === "binding" &&
      host.invocation.carriedValues === undefined
        ? {}
        : { runId: state.runId }),
      bindingId: run.bindingId,
      iteration:
        detached !== undefined && host.invocation.kind === "binding"
          ? host.invocation.iteration
          : iterationKey(state),
      ...(run.pendingContinuation === undefined ? {} : { continuation: run.pendingContinuation }),
      ...(run.continuationPlan === undefined ? {} : { continuationPlan: run.continuationPlan }),
      ...(typeof profileAccountId === "string" ? { profileAccountId } : {}),
    },
  );
};
