import "server-only";
import { openFlowCarriedValues, sealFlowCarriedValues } from "../workflows/flow-carried-values";
import type { QueryContinuationKey } from "../queries/continuation-token";
import type { FlowBindingEndpointDependencies } from "./flow-binding-endpoint";
import type { FlowOrchestrator } from "./flow-orchestrator";

type InvokeSegment = FlowBindingEndpointDependencies["invokeSegment"];
type OrchestratorFactory = (
  release: Parameters<InvokeSegment>[5],
  runId: string,
  installation: Parameters<InvokeSegment>[7],
) => FlowOrchestrator;

/** Wires a detached page segment through the existing admitted execution path. */
export const createDetachedSegmentInvoker =
  (continuationKey: QueryContinuationKey, orchestratorFor: OrchestratorFactory): InvokeSegment =>
  async (session, selection, binding, inputs, request, release, runId, installation) => {
    if (selection.applicationRootId === undefined) return { kind: "refused", committedNow: false };
    const plan = installation.plans.get(String(binding.flow.flowId));
    const segment = plan?.segments.find(
      (part) => part.kind === "server" && part.id === request.segment.segmentId,
    );
    if (plan === undefined || segment === undefined || segment.kind !== "server")
      return { kind: "refused", committedNow: false };
    const identity = {
      flowId: String(binding.flow.flowId),
      bindingId: String(binding.bindingId),
      identityId: session.identityId,
      organizationId: selection.organizationId,
      applicationRootId: selection.applicationRootId,
    };
    const opened = openFlowCarriedValues(request.carriedValues, continuationKey, identity, segment);
    const pageResolvedInputs = Object.entries(binding.flow.inputs).flatMap(([name, source]) =>
      Object.hasOwn(plan.browser.inputs, name) &&
      typeof source === "object" &&
      source.kind !== "caller" &&
      source.kind !== "literal"
        ? [name]
        : [],
    );
    const response = await orchestratorFor(release, runId, installation).invokeSegment(
      {
        session,
        selection,
        bindingId: binding.bindingId,
        gestureId: request.clickId,
        binding: { flowId: binding.flow.flowId, inputs },
        ...(request.subject === undefined ? {} : { subject: request.subject }),
      },
      {
        segmentId: segment.id,
        seed: request.seed,
        pageResolvedInputs,
        bindingSources: binding.flow.inputs,
        carriedValues: opened.values,
        ...(opened.runId === undefined ? {} : { runId: opened.runId }),
        entrySegments: request.entrySegments,
      },
    );
    if (response.kind !== "finished") return response;
    const carriedValues = sealFlowCarriedValues(
      opened.values,
      response.carriedOutputs ?? {},
      continuationKey,
      { ...identity, runId: response.runId },
      segment,
      plan.segments.some((part) => part.kind === "server" && part.tasks.length === 0),
      response.failure === undefined ? opened.failure : { segmentId: segment.id },
    );
    const { carriedOutputs, ...safe } = response;
    void carriedOutputs;
    return { ...safe, ...(carriedValues === undefined ? {} : { carriedValues }) };
  };
