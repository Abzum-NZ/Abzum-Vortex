import { safeFlowResultDescriptors } from "@vortex/platform/schema";
import type { FlowRuntimeOptions, FlowBindingReference } from "./flow-runtime";
import type { FlowSubjectContext } from "./server-flow-client";
import type { ServerDrivenResult } from "./server-driven-run";

/** Runs one scheduled binding after the page has loaded the flow driver. */
export async function runFlowBinding(
  options: FlowRuntimeOptions,
  binding: FlowBindingReference,
  callerInputs: Readonly<Record<string, unknown>> | undefined,
  clickId: string,
  runSignal: AbortSignal,
  subject: FlowSubjectContext | undefined,
  settings: NonNullable<ReturnType<FlowRuntimeOptions["bindingSettings"]>>,
): Promise<ServerDrivenResult> {
  const browser = options.browserBinding?.(binding.bindingId);
  if (browser !== undefined && options.timeZone !== undefined) {
    const { startBrowserFlow } = await import("./browser-flow-runner");
    const result = await startBrowserFlow({
      plan: browser.plan,
      bindings: browser.inputs,
      caller: callerInputs ?? {},
      runId: clickId,
      timeZone: options.timeZone,
      host: options.host,
      readFormValue: options.state.readFormValue,
      condition: settings.condition,
      signal: runSignal,
    });
    if (result.kind === "abandoned") return { kind: "abandoned", unanswered: true };
    if (result.kind === "skipped") return { kind: "skipped" };
    if (result.kind === "completed")
      return {
        kind: "finished",
        runId: clickId,
        descriptor: safeFlowResultDescriptors.completed,
        outputs: result.outputs,
      };
    if (result.kind === "failed")
      return {
        kind: "finished",
        runId: clickId,
        descriptor: safeFlowResultDescriptors[result.failure.outcome],
        outputs: {},
        failure: {
          code: result.failure.code,
          ...(result.failure.taskId === undefined ? {} : { taskId: result.failure.taskId }),
          ...(result.failure.diagnostic === undefined
            ? {}
            : { diagnostic: result.failure.diagnostic }),
        },
      };
  }
  const [first, { driveServerFlow }] = await Promise.all([
    options.client.startBinding(
      { bindingId: binding.bindingId, flowId: binding.flowId },
      callerInputs ?? {},
      clickId,
      runSignal,
      subject,
    ),
    import("./server-driven-run"),
  ]);
  return await driveServerFlow(
    options.client,
    binding.flowId,
    first,
    options.host,
    runSignal,
    options.committed === undefined ? undefined : () => options.committed?.(binding.bindingId),
  );
}
