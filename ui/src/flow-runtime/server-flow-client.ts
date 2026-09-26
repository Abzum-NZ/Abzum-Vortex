import type { JsonValue } from "@vortex/contracts";
import { isFlowIntent, type FlowIntent } from "./intents";

/** The address the signed-in person is using; the server resolves everything else from it. */
export type FlowApplicationAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
}>;

/** What the surface was rendered from, so the server can refuse a stale or foreign request. */
export type FlowInstallationContext = Readonly<{
  installationRevision: number;
  releaseKey: string;
}>;

export type FlowAnswer =
  | Readonly<{ kind: "form_answered"; submitted: boolean; values: JsonValue }>
  | Readonly<{ kind: "confirmed"; confirmed: boolean }>;

export type ServerFlowResponse =
  | Readonly<{ kind: "reload"; installationRevision: number }>
  | Readonly<{
      kind: "result";
      runId: string;
      descriptor: Readonly<{ outcome: string; commit: string; outputs: string; recovery: string }>;
      outputs: Readonly<Record<string, JsonValue>>;
      intents: readonly FlowIntent[];
      failure?: Readonly<{ code: string; taskId?: string }>;
    }>
  | Readonly<{
      kind: "intent";
      runId: string;
      awaiting: "form" | "confirm";
      intents: readonly FlowIntent[];
      continuation: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

export type FlowInvokeClient = Readonly<{
  startBinding: (
    binding: Readonly<{ bindingId: string; flowId: string }>,
    callerInputs: Readonly<Record<string, unknown>>,
    clickId: string,
  ) => Promise<ServerFlowResponse>;
  resume: (flowId: string, continuation: string, answer: FlowAnswer) => Promise<ServerFlowResponse>;
}>;

export type FlowInvokeClientOptions = Readonly<{
  address: FlowApplicationAddress;
  installation: FlowInstallationContext;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
}>;

const unavailable: ServerFlowResponse = Object.freeze({ kind: "unavailable" });
const refused: ServerFlowResponse = Object.freeze({ kind: "refused" });

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const parseIntents = (candidate: unknown): readonly FlowIntent[] | undefined =>
  Array.isArray(candidate) && candidate.every(isFlowIntent) ? candidate : undefined;

/** Fails closed: anything that is not exactly one of the endpoint's answers is `unavailable`. */
export const parseServerFlowResponse = (candidate: unknown): ServerFlowResponse => {
  if (!isRecord(candidate)) return unavailable;
  switch (candidate.kind) {
    case "refused":
      return refused;
    case "unavailable":
      return unavailable;
    case "reload":
      return typeof candidate.installationRevision === "number"
        ? { kind: "reload", installationRevision: candidate.installationRevision }
        : unavailable;
    case "intent": {
      const intents = parseIntents(candidate.intents);
      if (
        intents === undefined ||
        typeof candidate.runId !== "string" ||
        (candidate.awaiting !== "form" && candidate.awaiting !== "confirm") ||
        typeof candidate.continuation !== "string" ||
        typeof candidate.expiresAt !== "string"
      )
        return unavailable;
      return {
        kind: "intent",
        runId: candidate.runId,
        awaiting: candidate.awaiting,
        intents,
        continuation: candidate.continuation,
        expiresAt: candidate.expiresAt,
      };
    }
    case "result": {
      const intents = parseIntents(candidate.intents);
      const descriptor = candidate.descriptor;
      if (
        intents === undefined ||
        typeof candidate.runId !== "string" ||
        !isRecord(descriptor) ||
        typeof descriptor.outcome !== "string" ||
        typeof descriptor.commit !== "string" ||
        typeof descriptor.outputs !== "string" ||
        typeof descriptor.recovery !== "string" ||
        !isRecord(candidate.outputs)
      )
        return unavailable;
      const failure = candidate.failure;
      return {
        kind: "result",
        runId: candidate.runId,
        descriptor: {
          outcome: descriptor.outcome,
          commit: descriptor.commit,
          outputs: descriptor.outputs,
          recovery: descriptor.recovery,
        },
        outputs: candidate.outputs as Readonly<Record<string, JsonValue>>,
        intents,
        ...(isRecord(failure) && typeof failure.code === "string"
          ? {
              failure: {
                code: failure.code,
                ...(typeof failure.taskId === "string" ? { taskId: failure.taskId } : {}),
              },
            }
          : {}),
      };
    }
    default:
      return unavailable;
  }
};

/**
 * The page's client for the component event endpoint (#1014). It names only the application
 * address and the invocation; the organisation, installation and bindings are resolved on the
 * server. It sends a continuation exactly as the server issued it, together with only the person's
 * answer, and never states which path a flow took.
 */
export function createFlowInvokeClient(options: FlowInvokeClientOptions): FlowInvokeClient {
  const endpoint = options.endpoint ?? "/api/flows/invoke";
  const send = async (invocation: Record<string, unknown>): Promise<ServerFlowResponse> => {
    try {
      const response = await (options.fetchImplementation ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        // Exactly the endpoint's strict request shape: the three address parts and the invocation.
        body: JSON.stringify({
          tenantShortName: options.address.tenantShortName,
          organizationShortName: options.address.organizationShortName,
          applicationKey: options.address.applicationKey,
          invocation,
        }),
      });
      if (response.status === 401 || response.status === 403 || response.status === 413)
        return refused;
      return parseServerFlowResponse(await response.json());
    } catch {
      return unavailable;
    }
  };
  const context = {
    installationRevision: options.installation.installationRevision,
    releaseKey: options.installation.releaseKey,
  };
  return Object.freeze({
    startBinding: (binding, callerInputs, clickId) =>
      send({
        kind: "binding",
        ...context,
        bindingId: binding.bindingId,
        flowId: binding.flowId,
        clickId,
        callerInputs,
      }),
    resume: (flowId, continuation, answer) =>
      send({ kind: "continuation", ...context, flowId, continuation, answer }),
  });
}
