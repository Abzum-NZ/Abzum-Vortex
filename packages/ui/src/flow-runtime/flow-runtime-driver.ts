import { safeFlowResultDescriptors } from "@vortex/platform/schema";
import type { FlowRuntimeOptions, FlowBindingReference } from "./flow-runtime";
import type { FlowSubjectContext } from "./server-flow-client";
import type { ServerDrivenResult } from "./server-driven-run";

/** The page host of one binding's run: while a call waits on the person, the binding's timeout clock stands still. */
const hostWaitingOnPerson = (
  host: FlowRuntimeOptions["host"],
  hold: () => () => void,
): FlowRuntimeOptions["host"] => {
  const waiting = async <T>(call: () => T | Promise<T>): Promise<T> => {
    const release = hold();
    try {
      return await call();
    } finally {
      release();
    }
  };
  return {
    ...host,
    showMessage: (message, signal) => waiting(() => host.showMessage(message, signal)),
    showForm: (form, signal) => waiting(() => host.showForm(form, signal)),
    confirm: (confirmation, signal) => waiting(() => host.confirm(confirmation, signal)),
  };
};

/** Runs one scheduled binding after the page has loaded the flow driver. */
export async function runFlowBinding(
  options: FlowRuntimeOptions,
  binding: FlowBindingReference,
  callerInputs: Readonly<Record<string, unknown>> | undefined,
  clickId: string,
  runSignal: AbortSignal,
  subject: FlowSubjectContext | undefined,
  sourceTablePlacementId: string | undefined,
  settings: NonNullable<ReturnType<FlowRuntimeOptions["bindingSettings"]>>,
): Promise<ServerDrivenResult> {
  const pageHost = hostWaitingOnPerson(options.host, () =>
    options.state.holdTimeouts(binding.bindingId),
  );
  const browser = options.browserBinding?.(binding.bindingId);
  if (browser !== undefined && options.timeZone !== undefined) {
    const { startBrowserFlow } = await import("./browser-flow-runner");
    const result = await startBrowserFlow({
      plan: browser.plan,
      bindings: browser.inputs,
      event: binding.event,
      caller: callerInputs ?? {},
      runId: clickId,
      timeZone: options.timeZone,
      host: {
        ...pageHost,
        showMessage: (message, signal) =>
          pageHost.showMessage(
            {
              ...message,
              originBindingId: binding.bindingId,
              sourceFlowId: binding.flowId,
              ...(subject === undefined ? {} : { subject }),
              ...(sourceTablePlacementId === undefined ? {} : { sourceTablePlacementId }),
            },
            signal,
          ),
        setPageValues: options.state.pageValues.write,
        validateForm: options.state.validateForm,
        setFormValue: (form, field, value) => {
          const cycle = options.state.cycleFor(clickId);
          return cycle !== undefined && options.state.writeFormValue(form, field, value, cycle);
        },
      },
      readFormValue: options.state.readFormValue,
      readPageValues: options.state.pageValues.snapshot,
      condition: settings.condition,
      signal: runSignal,
      server: {
        client: options.client,
        binding,
        ...((subject ?? options.subject) === undefined
          ? {}
          : { subject: subject ?? options.subject }),
        ...(sourceTablePlacementId === undefined ? {} : { sourceTablePlacementId }),
      },
    });
    if (result.kind === "abandoned") return { kind: "abandoned", unanswered: true };
    if (result.kind === "skipped") return { kind: "skipped" };
    if (result.kind === "server_result") return result.result;
    if (result.kind === "completed")
      return {
        kind: "finished",
        runId: clickId,
        descriptor: result.committed
          ? safeFlowResultDescriptors.committed
          : safeFlowResultDescriptors.completed,
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
      {
        bindingId: binding.bindingId,
        flowId: binding.flowId,
        entrySegments: binding.entrySegments,
      },
      callerInputs ?? {},
      clickId,
      runSignal,
      subject,
      sourceTablePlacementId,
    ),
    import("./server-driven-run"),
  ]);
  return await driveServerFlow(
    options.client,
    binding.flowId,
    first,
    pageHost,
    runSignal,
    sourceTablePlacementId,
    binding.bindingId,
  );
}
