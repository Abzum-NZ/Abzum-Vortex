import "server-only";

import type {
  BoundHumanOrganizationRequest,
  HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import { continueFlowRun } from "../rules/flow-interpreter";
import { iterationKey } from "../rules/flow-interpreter-state";
import type { FlowBindingInvocation } from "../workflows/flow-invocation-contracts";
import { startFlow } from "../workflows/start";
import { canonicalJson } from "./canonical-json";
import { createHumanInstalledPageBundleContextLoader } from "./installed-page-bundle-context";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowOrchestratorDependencies, FlowRelease } from "./flow-orchestrator-types";
import type { ComponentFlowBinding } from "./application-flow-bindings";
import type { FlowRunState } from "../rules/flow-interpreter";

type AdmissionHost = Readonly<{
  requests: HumanOrganizationRequestDependencies;
  invocation: FlowBindingInvocation;
  installationOf: (context: InstalledRuntimeContext) => InstalledFlowBindings;
  pageGate: (
    context: InstalledRuntimeContext,
    binding: ComponentFlowBinding,
    bound: BoundHumanOrganizationRequest,
    installation: InstalledFlowBindings,
    state: FlowRunState,
  ) => Promise<boolean>;
  portsFor: (
    release: FlowRelease,
    runId: string,
    installation: InstalledFlowBindings,
    bound: BoundHumanOrganizationRequest,
  ) => FlowOrchestratorDependencies;
}>;

/** Resolves the current binding and plan inside the transaction admitting this segment. */
export const admitFlowSegment = async (
  host: AdmissionHost,
  installation: InstalledFlowBindings,
  ...args: Parameters<FlowOrchestratorDependencies["admitSegment"]>
): ReturnType<FlowOrchestratorDependencies["admitSegment"]> => {
  const [run, state, segment, execute] = args;
  const capturedBinding = installation.bindings.find((entry) =>
    sameId(entry.bindingId, run.bindingId),
  );
  if (capturedBinding === undefined) return { kind: "refused" };
  const selection = run.authority.selection;
  if (selection.applicationRootId === undefined) return { kind: "refused" };
  let currentInstallation: InstalledFlowBindings | undefined;
  let currentRelease: FlowRelease | undefined;
  const first =
    segment.preScopeLock === "organization_account"
      ? continueFlowRun(state, run.library, segment)
      : undefined;
  const inputs = first?.kind === "protected_task" ? first.call.properties.inputs?.value : undefined;
  const profileAccountId = isRecord(inputs)
    ? inputs.organization_account_id
    : first?.kind === "protected_task"
      ? first.call.flowInputs.organization_account_id?.value
      : undefined;
  const plan = run.release.plans.get(run.flowId);
  if (plan === undefined) return { kind: "refused" };
  return startFlow(
    {
      requests: host.requests,
      authorizeBinding: async (bound) => {
        if (bound.scope.applicationRootId === undefined) return false;
        const current = await createHumanInstalledPageBundleContextLoader({
          transaction: bound.transaction,
          scope: {
            organizationId: bound.scope.organizationId,
            organizationAccountId: bound.scope.organizationAccountId,
            applicationRootId: bound.scope.applicationRootId,
            ...(bound.scope.previewInstallationId === undefined
              ? {}
              : { previewInstallationId: bound.scope.previewInstallationId }),
          },
        }).load();
        currentInstallation = host.installationOf(current);
        const matches = currentInstallation.bindings.filter((entry) =>
          sameId(entry.bindingId, run.bindingId),
        );
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
        return host.pageGate(current, capturedBinding, bound, currentInstallation, state);
      },
      currentPlan: async () => {
        const currentPlan = currentInstallation?.plans.get(run.flowId);
        return currentPlan === undefined || currentInstallation === undefined
          ? undefined
          : { plan: currentPlan, installationRevision: currentInstallation.installationRevision };
      },
      authorizeInvocation: async (bound) => {
        if (currentRelease === undefined || currentInstallation === undefined) return false;
        const flow = currentRelease.flows.get(run.flowId);
        return (
          flow !== undefined &&
          (await host
            .portsFor(currentRelease, state.runId, currentInstallation, bound)
            .authorizeInvocation?.(run.authority.session, selection, flow)) === true
        );
      },
      execute: async (bound, _part, replay) => {
        if (currentRelease === undefined || currentInstallation === undefined)
          throw new Error("FLOW_ADMISSION_CONTEXT_UNAVAILABLE");
        return execute(
          host.portsFor(currentRelease, state.runId, currentInstallation, bound),
          replay,
        );
      },
    },
    {
      session: run.authority.session,
      selection,
      plan,
      expected: { segmentId: segment.id, fingerprint: segment.fingerprint },
      ...(host.invocation.kind === "binding"
        ? { entrySegments: host.invocation.entrySegments }
        : {}),
      gestureId: run.gestureId,
      runId: state.runId,
      bindingId: run.bindingId,
      iteration: iterationKey(state),
      channel: "page",
      ...(typeof profileAccountId === "string" ? { profileAccountId } : {}),
    },
  );
};
