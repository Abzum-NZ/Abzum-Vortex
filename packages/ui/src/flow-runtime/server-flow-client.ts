import {
  describeFailure,
  flowRefusalFeedbackSchema,
  type FlowWarningNotice,
  type FlowBindingInvocation,
  type FlowRefusalFeedback,
  type FormContinuationAnswer,
  type FormContinuationReceipt,
  type FormContinuationTarget,
  type JsonValue,
  isRecord,
} from "@vortex/platform/schema";
import { isFlowIntent, type FlowIntent } from "./intents";
import type { PlacementFlowBinding } from "./flow-runtime";

/** The address the signed-in person is using; the server resolves everything else from it. */
export type FlowApplicationAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  pageKey: string;
  /** The record the page was opened for, when it has one: part of the page's address. */
  pageRecordId?: string;
}>;

/** What the surface was rendered from, so the server can refuse a stale or foreign request. */
export type FlowInstallationContext = Readonly<{
  installationRevision: number;
  releaseKey: string;
}>;

/**
 * The exact evidence the server issued with a paused run, returned with the continuation so the
 * server can compare it with trusted state. The page never invents it: it stores what the previous
 * response carried and sends it back unchanged.
 */
export type FlowResumeEvidence = Readonly<{
  /** The exact paused target: installation, release, flow, node, awaiting form and receipt. */
  target?: FormContinuationTarget;
  /** The run receipt: which run and how many protected effects it has committed. */
  receipt?: FormContinuationReceipt;
}>;

export type ServerFlowResponse =
  | Readonly<{ kind: "reload"; installationRevision: number }>
  | Readonly<{
      kind: "result";
      warnings: readonly FlowWarningNotice[];
      runId: string;
      descriptor: Readonly<{ outcome: string; commit: string; outputs: string; recovery: string }>;
      outputs: Readonly<Record<string, JsonValue>>;
      intents: readonly FlowIntent[];
      failure?: Readonly<{ code: string; taskId?: string; diagnostic?: FlowRefusalFeedback }>;
    }>
  | Readonly<{
      kind: "intent";
      runId: string;
      awaiting: "form" | "confirm";
      intents: readonly FlowIntent[];
      continuation: string;
      expiresAt: string;
      target?: FormContinuationTarget;
      receipt?: FormContinuationReceipt;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

export type FlowInvokeClient = Readonly<{
  startBinding: (
    binding: Pick<PlacementFlowBinding, "bindingId" | "flowId" | "segment">,
    callerInputs: Readonly<Record<string, unknown>>,
    clickId: string,
    signal?: AbortSignal,
    /** The one record this gesture is about, when it is not the record the page was rendered for. */
    subject?: FlowSubjectContext,
  ) => Promise<ServerFlowResponse>;
  resume: (
    flowId: string,
    continuation: string,
    answer: FormContinuationAnswer,
    evidence?: FlowResumeEvidence,
    signal?: AbortSignal,
  ) => Promise<ServerFlowResponse>;
}>;

/**
 * The record the surface was rendered for and the revision it showed, sent with every binding
 * start. It is evidence only: the server's protected record paths decide what it may be used for.
 */
export type FlowSubjectContext = Readonly<{ recordId: string; revision: number }>;

export type FlowInvokeClientOptions = Readonly<{
  address: FlowApplicationAddress;
  installation: FlowInstallationContext;
  /** Current address and declared control values, sampled when each request is sent. */
  pageInputs?: () => Readonly<{
    parameters: Readonly<Record<string, string | readonly string[]>>;
    controls: Readonly<Record<string, string>>;
  }>;
  subject?: FlowSubjectContext;
  endpoint?: string;
  fetchImplementation?: typeof fetch;
}>;

const unavailable: ServerFlowResponse = Object.freeze({ kind: "unavailable" });
const refused: ServerFlowResponse = Object.freeze({ kind: "refused" });
const invalidServerResponse = (cause: unknown = new TypeError("FLOW_SERVER_RESPONSE_INVALID")) => {
  console.error(`[flow] server response invalid: ${describeFailure(cause)}`);
  return unavailable;
};

const parseIntents = (candidate: unknown): readonly FlowIntent[] | undefined =>
  Array.isArray(candidate) && candidate.every(isFlowIntent) ? candidate : undefined;

/** Exactly a committed save's authored warning: its task and a non-blank message. */
const isWarningNotice = (candidate: unknown): candidate is FlowWarningNotice =>
  isRecord(candidate) &&
  Object.keys(candidate).length === 2 &&
  typeof candidate.taskId === "string" &&
  typeof candidate.message === "string" &&
  candidate.message.length > 0;

/**
 * The paused target and run receipt are evidence the server built through their contracts. The
 * page keeps them unchanged and returns them with the continuation, where the endpoint's strict
 * request contract and the server's trusted state check them again.
 */
const isEvidence = (candidate: unknown): boolean => candidate === undefined || isRecord(candidate);

/** Fails closed: anything that is not exactly one of the endpoint's answers is `unavailable`. */
export const parseServerFlowResponse = (candidate: unknown): ServerFlowResponse => {
  if (!isRecord(candidate)) return invalidServerResponse();
  switch (candidate.kind) {
    case "refused":
      return refused;
    case "unavailable":
      return unavailable;
    case "reload":
      return typeof candidate.installationRevision === "number"
        ? { kind: "reload", installationRevision: candidate.installationRevision }
        : invalidServerResponse();
    case "intent": {
      const intents = parseIntents(candidate.intents);
      if (
        intents === undefined ||
        !isEvidence(candidate.target) ||
        !isEvidence(candidate.receipt) ||
        typeof candidate.runId !== "string" ||
        (candidate.awaiting !== "form" && candidate.awaiting !== "confirm") ||
        typeof candidate.continuation !== "string" ||
        typeof candidate.expiresAt !== "string"
      )
        return invalidServerResponse();
      return {
        kind: "intent",
        runId: candidate.runId,
        awaiting: candidate.awaiting,
        intents,
        continuation: candidate.continuation,
        expiresAt: candidate.expiresAt,
        ...(candidate.target === undefined
          ? {}
          : { target: candidate.target as FormContinuationTarget }),
        ...(candidate.receipt === undefined
          ? {}
          : { receipt: candidate.receipt as FormContinuationReceipt }),
      };
    }
    case "result": {
      const warnings = candidate.warnings;
      if (!Array.isArray(warnings) || !warnings.every(isWarningNotice))
        return invalidServerResponse();
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
        return invalidServerResponse();
      const failure = candidate.failure;
      let acceptedFailure: Extract<ServerFlowResponse, { kind: "result" }>["failure"];
      if (failure !== undefined && !isRecord(failure)) return invalidServerResponse();
      if (isRecord(failure)) {
        const allowedFailureKeys = new Set(["code", "taskId", "diagnostic"]);
        if (
          Object.keys(failure).some((key) => !allowedFailureKeys.has(key)) ||
          typeof failure.code !== "string" ||
          (failure.taskId !== undefined && typeof failure.taskId !== "string")
        )
          return invalidServerResponse();
        let diagnostic: FlowRefusalFeedback | undefined;
        if (failure.diagnostic !== undefined) {
          const parsed = flowRefusalFeedbackSchema.safeParse(failure.diagnostic);
          if (!parsed.success) return invalidServerResponse(parsed.error);
          if (parsed.data.operationInput !== undefined)
            return invalidServerResponse(
              new TypeError("FLOW_SERVER_DIAGNOSTIC_CONTAINS_OPERATION_INPUT"),
            );
          diagnostic = parsed.data;
        }
        acceptedFailure = {
          code: failure.code,
          ...(typeof failure.taskId === "string" ? { taskId: failure.taskId } : {}),
          ...(diagnostic === undefined ? {} : { diagnostic }),
        };
      }
      return {
        kind: "result",
        warnings,
        runId: candidate.runId,
        descriptor: {
          outcome: descriptor.outcome,
          commit: descriptor.commit,
          outputs: descriptor.outputs,
          recovery: descriptor.recovery,
        },
        outputs: candidate.outputs as Readonly<Record<string, JsonValue>>,
        intents,
        ...(acceptedFailure === undefined ? {} : { failure: acceptedFailure }),
      };
    }
    default:
      return invalidServerResponse();
  }
};

/**
 * The page's client for the component event endpoint. It names only the application
 * address and the invocation; the organisation, installation and bindings are resolved on the
 * server. It sends a continuation exactly as the server issued it, together with only the person's
 * answer, and never states which path a flow took.
 */
export function createFlowInvokeClient(options: FlowInvokeClientOptions): FlowInvokeClient {
  const endpoint = options.endpoint ?? "/api/flows/invoke";
  const send = async (
    invocation: FlowBindingInvocation,
    signal?: AbortSignal,
  ): Promise<ServerFlowResponse> => {
    if (signal?.aborted) return unavailable;
    try {
      const response = await (options.fetchImplementation ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        ...(signal === undefined ? {} : { signal }),
        // Exactly the endpoint's strict request shape: the addressed page and the invocation. The
        // endpoint checks it against the invocation contract and refuses anything else.
        body: JSON.stringify({
          tenantShortName: options.address.tenantShortName,
          organizationShortName: options.address.organizationShortName,
          applicationKey: options.address.applicationKey,
          pageKey: options.address.pageKey,
          ...(options.address.pageRecordId === undefined
            ? {}
            : { pageRecordId: options.address.pageRecordId }),
          pageInputs: options.pageInputs?.() ?? { parameters: {}, controls: {} },
          invocation,
        }),
      });
      if (response.status === 401 || response.status === 403 || response.status === 413)
        return refused;
      return parseServerFlowResponse(await response.json());
    } catch (error) {
      if (signal?.aborted) return unavailable;
      console.error(`[flow] invoke request failed: ${describeFailure(error)}`);
      return unavailable;
    }
  };
  const context = {
    installationRevision: options.installation.installationRevision,
    releaseKey: options.installation.releaseKey,
  };
  return Object.freeze({
    startBinding: (binding, callerInputs, clickId, signal, subject) =>
      send(
        {
          kind: "binding",
          ...context,
          bindingId: binding.bindingId,
          flowId: binding.flowId,
          segment: binding.segment,
          clickId,
          callerInputs,
          ...((subject ?? options.subject) === undefined
            ? {}
            : { subject: subject ?? options.subject }),
        },
        signal,
      ),
    resume: (flowId, continuation, answer, evidence, signal) =>
      send(
        {
          kind: "continuation",
          ...context,
          flowId,
          continuation,
          answer,
          ...(evidence?.target === undefined ? {} : { target: evidence.target }),
          ...(evidence?.receipt === undefined ? {} : { receipt: evidence.receipt }),
        },
        signal,
      ),
  });
}
