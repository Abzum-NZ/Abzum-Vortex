import { safeFlowResultDescriptors } from "@vortex/platform/schema";
import type { FlowRuntimeOptions, FlowBindingReference } from "./flow-runtime";
import type { FlowSubjectContext } from "./server-flow-client";
import type { PageDriver } from "../agent/page-driver";
import type { FlowDispatchResult } from "./flow-runtime";

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

/**
 * The page host of an agent's run: Navigate and Show message reach the page and the agent's driver,
 * and every confirmation is the driver's, which on a screen asks the person.
 */
const hostForAgent = (
  host: FlowRuntimeOptions["host"],
  driver: PageDriver,
): FlowRuntimeOptions["host"] => ({
  ...host,
  navigate: async (intent) => {
    await driver.navigate(intent);
    return host.navigate(intent);
  },
  showMessage: async (message, signal) => {
    await driver.showMessage(message, signal);
    await host.showMessage(message, signal);
  },
  confirm: (confirmation, signal) => driver.confirm(confirmation, signal),
});

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
  agent: PageDriver | undefined,
): Promise<FlowDispatchResult> {
  const client = agent === undefined ? options.client : options.agentClient;
  if (client === undefined) {
    console.error("[flow] an agent's run needs the agent endpoint, which this page does not have");
    return { kind: "refused" };
  }
  const pageHost = hostWaitingOnPerson(
    agent === undefined ? options.host : hostForAgent(options.host, agent),
    () => options.state.holdTimeouts(binding.bindingId),
  );
  // An agent never deletes, changes records in bulk or starts a back-end run before the person
  // confirms it on the page; a flow that asks first itself needs no second question.
  if (agent !== undefined && settings.agentConfirmation === true) {
    const answer = await pageHost.confirm(
      {
        title: "Allow the agent?",
        message:
          settings.controlName === settings.flowName
            ? `An agent working for you wants to run ${settings.flowName}.`
            : `An agent working for you wants to run ${settings.flowName} (${settings.controlName}).`,
        details: [],
        choice: undefined,
        confirmLabel: "Allow",
        destructive: true,
      },
      runSignal,
    );
    if (runSignal.aborted) return { kind: "abandoned" };
    if (!answer.confirmed)
      return { kind: "refused", reason: "You did not allow the agent's action." };
  }
  const browser = options.browserBinding(binding.bindingId);
  if (browser === undefined || options.timeZone === undefined) {
    console.error(`[flow] binding ${binding.bindingId} has no page plan or time zone`);
    return { kind: "refused" };
  }
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
        return (
          cycle !== undefined &&
          options.state.writeFormValue(form, field, value, cycle).kind === "set"
        );
      },
    },
    readFormValue: options.state.readFormValue,
    readPageValues: options.state.pageValues.snapshot,
    condition: settings.condition,
    signal: runSignal,
    server: {
      client,
      binding,
      ...((subject ?? options.subject) === undefined
        ? {}
        : { subject: subject ?? options.subject }),
      ...(sourceTablePlacementId === undefined ? {} : { sourceTablePlacementId }),
    },
  });
  if (result.kind === "abandoned") return { kind: "abandoned" };
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
  return {
    kind: "finished",
    runId: clickId,
    descriptor: safeFlowResultDescriptors[result.failure.outcome],
    outputs: {},
    failure: {
      code: result.failure.code,
      ...(result.failure.taskId === undefined ? {} : { taskId: result.failure.taskId }),
      ...(result.failure.diagnostic === undefined ? {} : { diagnostic: result.failure.diagnostic }),
    },
  };
}
