import type {
  FlowInvokeClient,
  FlowInvokeClientOptions,
  ServerFlowResponse,
} from "./server-flow-client";

/** Loads the protected-flow client only when a request needs it. */
export function createFlowInvokeClient(options: FlowInvokeClientOptions): FlowInvokeClient {
  let pending: Promise<FlowInvokeClient> | undefined;
  const client = () => {
    pending ??= import("./server-flow-client")
      .then((module) => module.createFlowInvokeClient(options))
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
    startBinding: (...args) =>
      client()
        .then((loaded) => loaded.startBinding(...args))
        .catch(unavailable),
    resume: (...args) =>
      client()
        .then((loaded) => loaded.resume(...args))
        .catch(unavailable),
  };
}
