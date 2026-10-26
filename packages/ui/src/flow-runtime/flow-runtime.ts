import type { ComponentFlowBinding } from "@vortex/platform/schema";
import type { FlowIntentHost } from "./intents";
import { driveServerFlow, type ServerDrivenResult } from "./server-driven-run";
import type { FlowInvokeClient, FlowSubjectContext } from "./server-flow-client";

export type FlowRuntimeOptions = Readonly<{
  client: FlowInvokeClient;
  host: FlowIntentHost;
  /**
   * Told, with the binding's identity, when a server run of that binding committed and before its
   * closing messages are shown, so the page can re-read the placements the binding writes.
   */
  committed?: (bindingId: string) => void;
}>;

/** The safe identity of a binding used by a surface that does not receive its input map. */
export type FlowBindingReference = Readonly<{
  bindingId: string;
  flowId: string;
  event: string;
}>;

export type FlowRuntime = Readonly<{
  /**
   * Runs the flow bound to one component event: the server starts it and the page drives it through
   * its continuations. `clickId` is the one identity of the user gesture: supplying the same
   * identity for a repeated request makes the server reach the same run, so a resubmission never
   * commits a second time.
   */
  dispatch: (
    binding: ComponentFlowBinding,
    callerInputs?: Readonly<Record<string, unknown>>,
    clickId?: string,
    subject?: FlowSubjectContext,
  ) => Promise<ServerDrivenResult>;
  /** Starts one exact server binding and drives its normal intents and continuations. */
  dispatchReference: (
    binding: FlowBindingReference,
    callerInputs?: Readonly<Record<string, unknown>>,
    clickId?: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
  ) => Promise<ServerDrivenResult>;
}>;

export function createFlowRuntime(options: FlowRuntimeOptions): FlowRuntime {
  const dispatchReference = async (
    binding: FlowBindingReference,
    callerInputs: Readonly<Record<string, unknown>> = {},
    clickId?: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
  ): Promise<ServerDrivenResult> => {
    if (signal?.aborted) return { kind: "abandoned", unanswered: true };
    const first = await options.client.startBinding(
      { bindingId: binding.bindingId, flowId: binding.flowId },
      callerInputs,
      clickId ?? crypto.randomUUID(),
      signal,
      subject,
    );
    return driveServerFlow(
      options.client,
      binding.flowId,
      first,
      options.host,
      signal,
      options.committed === undefined ? undefined : () => options.committed?.(binding.bindingId),
    );
  };
  return Object.freeze({
    dispatchReference,
    dispatch: (binding, callerInputs = {}, clickId, subject) =>
      dispatchReference(
        { bindingId: binding.bindingId, flowId: binding.flow.flowId, event: binding.event },
        callerInputs,
        clickId,
        undefined,
        subject,
      ),
  });
}
