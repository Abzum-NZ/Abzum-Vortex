import type { ComponentFlowBinding, JsonValue } from "@vortex/platform/schema";
import type { FlowLibrary } from "@vortex/platform/schema";
import type { BrowserFlowResult } from "./browser-flow-runner";
import type { FlowIntentHost } from "./intents";
import { driveServerFlow, type ServerDrivenResult } from "./server-driven-run";
import type { FlowInvokeClient, FlowSubjectContext } from "./server-flow-client";

export type FlowDispatchResult =
  | Readonly<{ ranIn: "browser"; result: BrowserFlowResult }>
  | Readonly<{ ranIn: "server"; result: ServerDrivenResult }>;

export type FlowRuntimeOptions = Readonly<{
  client: FlowInvokeClient;
  host: FlowIntentHost;
  /**
   * The compiled flows of the exact release the page was rendered from, when the page holds them.
   * A flow missing here is always driven by the server, never guessed to be browser-only.
   */
  library?: FlowLibrary;
  clock?: () => string;
  newId?: () => string;
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
   * Runs the flow bound to one component event. A browser-only flow runs in the page; every other
   * flow is started on the server and driven through its continuations. `clickId` is the one
   * identity of the user gesture: supplying the same identity for a repeated request makes the
   * server reach the same run, so a resubmission never commits a second time.
   */
  dispatch: (
    binding: ComponentFlowBinding,
    callerInputs?: Readonly<Record<string, unknown>>,
    clickId?: string,
    subject?: FlowSubjectContext,
  ) => Promise<FlowDispatchResult>;
  /** Starts one exact server binding and drives its normal intents and continuations. */
  dispatchReference: (
    binding: FlowBindingReference,
    callerInputs?: Readonly<Record<string, unknown>>,
    clickId?: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
  ) => Promise<FlowDispatchResult>;
}>;

/**
 * The inputs of a binding the page can fill itself: its literals and the caller inputs it declares.
 * Undefined when an input needs page data this module does not evaluate, or a surface supplies a
 * value the binding does not declare, so the click is refused instead of run half-filled.
 */
const bindingInputs = (
  binding: ComponentFlowBinding,
  callerInputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined => {
  const inputs: Record<string, unknown> = {};
  const declared = new Set<string>();
  for (const [name, value] of Object.entries(binding.flow.inputs)) {
    if (typeof value !== "object" || value === null) return undefined;
    if (value.kind === "literal") inputs[name] = value.literal.value as JsonValue;
    else if (value.kind === "caller") {
      declared.add(value.name);
      if (!Object.hasOwn(callerInputs, value.name)) return undefined;
      inputs[name] = callerInputs[value.name];
    } else return undefined;
  }
  for (const name of Object.keys(callerInputs)) if (!declared.has(name)) return undefined;
  return inputs;
};

export function createFlowRuntime(options: FlowRuntimeOptions): FlowRuntime {
  const clock = options.clock ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const dispatchReference = async (
    binding: FlowBindingReference,
    callerInputs: Readonly<Record<string, unknown>> = {},
    clickId?: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
  ): Promise<FlowDispatchResult> => {
    if (signal?.aborted)
      return { ranIn: "server", result: { kind: "abandoned", unanswered: true } };
    const first = await options.client.startBinding(
      { bindingId: binding.bindingId, flowId: binding.flowId },
      callerInputs,
      clickId ?? newId(),
      signal,
      subject,
    );
    return {
      ranIn: "server",
      result: await driveServerFlow(
        options.client,
        binding.flowId,
        first,
        options.host,
        signal,
        options.committed === undefined ? undefined : () => options.committed?.(binding.bindingId),
      ),
    };
  };
  return Object.freeze({
    dispatchReference,
    async dispatch(binding, callerInputs = {}, clickId, subject): Promise<FlowDispatchResult> {
      const flowId = binding.flow.flowId;
      const library = options.library;
      // The browser flow engine loads with the first flow a page runs, never with the page itself.
      // A form submit carries the surface's own submission envelope; the server's form-submit
      // adapter projects it and the endpoint validates it, so it is never pre-filtered here.
      if (
        binding.event !== "form_submit" &&
        library !== undefined &&
        (await import("./browser-eligibility")).flowRunsOnlyInBrowser(flowId, library)
      ) {
        const inputs = bindingInputs(binding, callerInputs);
        if (inputs === undefined)
          return {
            ranIn: "browser",
            result: {
              kind: "failed",
              failure: { outcome: "failed", code: "inputs_invalid" },
            },
          };
        return {
          ranIn: "browser",
          result: await (
            await import("./browser-flow-runner")
          ).runBrowserFlow(
            { flowId, inputs, runId: clickId ?? newId(), now: clock() },
            library,
            options.host,
          ),
        };
      }
      return dispatchReference(
        { bindingId: binding.bindingId, flowId, event: binding.event },
        callerInputs,
        clickId,
        undefined,
        subject,
      );
    },
  });
}
