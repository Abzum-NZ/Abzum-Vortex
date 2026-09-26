import type { JsonValue } from "@vortex/contracts";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowFailure,
  type FlowInterfaceIntent,
  type FlowLibrary,
  type FlowRunStep,
} from "@vortex/rule";
import { flowRunsOnlyInBrowser } from "./browser-eligibility";
import {
  performPresentationIntent,
  readConfirmIntent,
  readFormIntent,
  type FlowIntent,
  type FlowIntentHost,
} from "./intents";

export type BrowserFlowResult =
  /** The flow ran to its end in the page. */
  | Readonly<{
      kind: "completed";
      outputs: Readonly<Record<string, JsonValue>>;
      stopped?: string;
    }>
  | Readonly<{ kind: "failed"; failure: FlowFailure }>
  /** The flow is not browser-only, so the page never ran any of it. */
  | Readonly<{ kind: "not_browser_only" }>
  /** The person's surface went away before answering; the run stopped without an answer. */
  | Readonly<{ kind: "abandoned" }>;

export type BrowserFlowRequest = Readonly<{
  flowId: string;
  inputs: Readonly<Record<string, unknown>>;
  runId: string;
  now: string;
}>;

const toIntent = (intent: FlowInterfaceIntent): FlowIntent => ({
  kind: intent.kind,
  taskId: intent.taskId,
  properties: Object.fromEntries(
    Object.entries(intent.properties).map(([name, value]) => [name, value.value]),
  ),
});

const maximumSuspensions = 50;

/**
 * Runs a browser-only flow entirely in the page with the shared pure interpreter. The page carries
 * out interface intents and answers forms and confirmations itself; it never runs a protected task.
 * A flow that is not browser-only is refused before any task runs, and a protected task step (which
 * eligibility rules out) stops the run as a failure instead of being answered by the page.
 */
export async function runBrowserFlow(
  request: BrowserFlowRequest,
  library: FlowLibrary,
  host: FlowIntentHost,
): Promise<BrowserFlowResult> {
  if (!flowRunsOnlyInBrowser(request.flowId, library)) return { kind: "not_browser_only" };
  let step: FlowRunStep = startFlowRun(
    { runId: request.runId, flowId: request.flowId, inputs: request.inputs, now: request.now },
    library,
  );
  try {
    for (let suspensions = 0; suspensions <= maximumSuspensions; suspensions += 1) {
      const intents = step.kind === "protected_task" ? [] : step.intents.map(toIntent);
      const waiting = step.kind === "interface" ? intents.at(-1) : undefined;
      for (const intent of waiting === undefined ? intents : intents.slice(0, -1))
        await performPresentationIntent(intent, host);

      if (step.kind === "finished")
        return step.result.status === "completed"
          ? {
              kind: "completed",
              outputs: Object.fromEntries(
                Object.entries(step.result.outputs).map(([name, value]) => [name, value.value]),
              ),
              ...(step.result.stopped === undefined ? {} : { stopped: step.result.stopped }),
            }
          : { kind: "failed", failure: step.result.failure };
      if (step.kind === "protected_task")
        return {
          kind: "failed",
          failure: { outcome: "failed", code: "task_not_available", taskId: step.call.taskId },
        };

      if (step.awaiting === "form") {
        const form = waiting?.kind === "show_form" ? readFormIntent(waiting) : undefined;
        if (form === undefined)
          return { kind: "failed", failure: { outcome: "failed", code: "value_unresolved" } };
        const answer = await host.showForm(form);
        step = resumeFlowRun(
          step.state,
          {
            kind: "form_answered",
            submitted: answer.submitted,
            values: answer.submitted ? answer.values : null,
          },
          library,
        );
      } else {
        const confirmation = waiting?.kind === "confirm" ? readConfirmIntent(waiting) : undefined;
        if (confirmation === undefined)
          return { kind: "failed", failure: { outcome: "failed", code: "value_unresolved" } };
        step = resumeFlowRun(
          step.state,
          { kind: "confirmed", confirmed: await host.confirm(confirmation) },
          library,
        );
      }
    }
    return { kind: "failed", failure: { outcome: "failed", code: "step_limit" } };
  } catch {
    return { kind: "abandoned" };
  }
}
