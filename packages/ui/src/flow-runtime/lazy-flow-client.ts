import type {
  FlowInvokeClient,
  FlowInvokeClientOptions,
  ServerFlowResponse,
} from "./server-flow-client";

/** Loads the protected-flow client only when a request needs it. */
export function createFlowInvokeClient(
  options: FlowInvokeClientOptions,
  wrap: () => Promise<(client: FlowInvokeClient) => FlowInvokeClient>,
): FlowInvokeClient {
  let pending: Promise<FlowInvokeClient> | undefined;
  const client = () => {
    pending ??= Promise.all([import("./server-flow-client"), wrap()])
      .then(([module, track]) => track(module.createFlowInvokeClient(options)))
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
  const unavailable = (error: unknown): ServerFlowResponse => {
    console.error("[flow] invoke client failed to load", error);
    return { kind: "unavailable" };
  };
  return {
    openRun: (...args) =>
      client()
        .then((loaded) => loaded.openRun(...args))
        .catch(unavailable),
    startBinding: (...args) =>
      client()
        .then((loaded) => loaded.startBinding(...args))
        .catch(unavailable),
  };
}
