import {
  describeFailure,
  resumeFlowRun,
  startPageFlowSegment,
  type FlowFormReferenceResolver,
  type FlowInterfaceIntent,
  type FlowOutputMemberTypeResolver,
  type FlowProgram,
  type FlowProgramLibrary,
  type FlowRunStart,
  type FlowRunState,
  type FlowRunStep,
} from "@vortex/platform/schema";
import {
  isSurfaceCancellation,
  readMessageIntent,
  type FlowIntent,
  type FlowIntentHost,
} from "./intents";
import { performPageFlowIntent } from "./page-step-implementations";

export type PageFlowSegmentResult =
  | Extract<FlowRunStep, { kind: "finished" }>
  | Readonly<{ kind: "abandoned" }>
  | Readonly<{ kind: "unavailable" }>;

const toIntent = (intent: FlowInterfaceIntent): FlowIntent => ({
  kind: intent.kind,
  taskId: intent.taskId,
  properties: Object.fromEntries(
    Object.entries(intent.properties).map(([name, value]) => [name, value.value]),
  ),
});

/** Executes one page segment with the shared interpreter and the one page-step map. */
export async function drivePageFlowSegment(
  input: Readonly<{
    program: FlowProgram;
    start: FlowRunStart;
    previous?: FlowRunState;
    resolveMember: FlowOutputMemberTypeResolver;
    resolveForm?: FlowFormReferenceResolver;
    host: FlowIntentHost;
    signal?: AbortSignal;
  }>,
): Promise<PageFlowSegmentResult> {
  const { program, start, previous, resolveMember, resolveForm, host, signal } = input;
  const library: FlowProgramLibrary = (id) => (id === program.id ? program : undefined);
  try {
    let step = startPageFlowSegment(program, start, resolveMember, previous, resolveForm);
    for (let round = 0; round < 50; round += 1) {
      if (signal?.aborted) return { kind: "abandoned" };
      if (step.kind === "protected_task") {
        console.error("[flow] protected task appeared in a page segment");
        return { kind: "unavailable" };
      }
      const intents = step.intents.map(toIntent);
      const waiting = step.kind === "interface" ? intents.at(-1) : undefined;
      for (const intent of waiting === undefined ? intents : intents.slice(0, -1)) {
        if (signal?.aborted) return { kind: "abandoned" };
        if (intent.kind === "confirm" || intent.kind === "show_form")
          throw new Error("FLOW_PAGE_UNEXPECTED_PAUSE");
        if (
          step.kind === "finished" &&
          step.result.status === "failed" &&
          intent.kind === "show_message" &&
          readMessageIntent(intent)?.severity === "success"
        )
          continue;
        await performPageFlowIntent(intent, host, signal);
      }
      if (signal?.aborted) return { kind: "abandoned" };
      if (step.kind === "finished") return step;
      if (
        waiting === undefined ||
        waiting.kind !== (step.awaiting === "form" ? "show_form" : "confirm")
      )
        throw new Error("FLOW_PAGE_PAUSE_INVALID");
      const answer = await performPageFlowIntent(waiting, host, signal);
      if (signal?.aborted) return { kind: "abandoned" };
      if (answer === undefined) throw new Error("FLOW_PAGE_ANSWER_INVALID");
      step = resumeFlowRun(step.state, answer, library, resolveMember, undefined, resolveForm);
    }
    throw new Error("FLOW_PAGE_SUSPENSION_LIMIT");
  } catch (error) {
    if (signal?.aborted || isSurfaceCancellation(error)) return { kind: "abandoned" };
    console.error(`[flow] page segment failed: ${describeFailure(error)}`);
    return { kind: "unavailable" };
  }
}
