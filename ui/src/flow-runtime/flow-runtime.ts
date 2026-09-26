import type { ComponentFlowBinding, JsonValue } from "@vortex/contracts";
import type { FlowLibrary } from "@vortex/rule";
import { runBrowserFlow, type BrowserFlowResult } from "./browser-flow-runner";
import { flowRunsOnlyInBrowser } from "./browser-eligibility";
import type { FlowIntentHost } from "./intents";
import { driveServerFlow, type ServerDrivenResult } from "./server-driven-run";
import type { FlowInvokeClient } from "./server-flow-client";

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
}>;

export type FlowRuntime = Readonly<{
  /**
   * Runs the flow bound to one component event. A browser-only flow runs in the page; every other
   * flow is started on the server and driven through its continuations.
   */
  dispatch: (
    binding: ComponentFlowBinding,
    callerInputs?: Readonly<Record<string, unknown>>,
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
  return Object.freeze({
    async dispatch(binding, callerInputs = {}): Promise<FlowDispatchResult> {
      const flowId = binding.flow.flowId;
      const library = options.library;
      if (library !== undefined && flowRunsOnlyInBrowser(flowId, library)) {
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
          result: await runBrowserFlow(
            { flowId, inputs, runId: newId(), now: clock() },
            library,
            options.host,
          ),
        };
      }
      // One identity per gesture, so a repeated request for the same click is the same run.
      const first = await options.client.startBinding(
        { bindingId: binding.bindingId, flowId },
        callerInputs,
        newId(),
      );
      return {
        ranIn: "server",
        result: await driveServerFlow(options.client, flowId, first, options.host),
      };
    },
  });
}
