import {
  describeFailure,
  flowRefusalFeedbackSchema,
  recordsTableBatchEditProblemSchema,
  type RecordsTableBatchEditProblem,
  type FlowWarningNotice,
  type FlowBindingInvocation,
  type FlowRefusalFeedback,
  type JsonValue,
  isRecord,
} from "@vortex/platform/schema";
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

export type ServerFlowResponse =
  | Readonly<{ kind: "run_opened"; carriedValues: string }>
  | Readonly<{ kind: "reload"; installationRevision: number }>
  | Readonly<{
      kind: "result";
      warnings: readonly FlowWarningNotice[];
      runId: string;
      descriptor: Readonly<{ outcome: string; commit: string; outputs: string; recovery: string }>;
      outputs: Readonly<Record<string, JsonValue>>;
      stopped?: string;
      carriedValues?: string;
      failure?: Readonly<{ code: string; taskId?: string; diagnostic?: FlowRefusalFeedback }>;
    }>
  | Readonly<{ kind: "refused" }>
  /** A pasted, filled or undone batch stopped before any cell was written: every cell that stopped it. */
  | Readonly<{ kind: "cells_refused"; problems: readonly RecordsTableBatchEditProblem[] }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "unknown" }>;

export type FlowInvokeClient = Readonly<{
  openRun: (
    binding: Pick<PlacementFlowBinding, "bindingId" | "flowId" | "entrySegments">,
    clickId: string,
    signal?: AbortSignal,
    sourceTablePlacementId?: string,
  ) => Promise<ServerFlowResponse>;
  startBinding: (
    binding: Pick<PlacementFlowBinding, "bindingId" | "flowId" | "entrySegments">,
    callerInputs: Readonly<Record<string, unknown>>,
    clickId: string,
    signal: AbortSignal | undefined,
    /** The one record this gesture is about, when it is not the record the page was rendered for. */
    subject: FlowSubjectContext | undefined,
    sourceTablePlacementId: string | undefined,
    carriedValues: string | undefined,
    /** The one server segment this request runs, with the page values it starts from. */
    segmentValues: Readonly<{
      seed: Readonly<Record<string, JsonValue>>;
      iteration: string;
      phase?: "success" | "page_failure";
      segment: Readonly<{ segmentId: string; fingerprint: string }>;
    }>,
  ) => Promise<ServerFlowResponse>;
}>;

/**
 * The record the surface was rendered for and the revision it showed, sent with every binding
 * start. It is evidence only: the server's protected record paths decide what it may be used for.
 */
export type FlowSubjectContext = Readonly<{ recordId: string; revision: number }>;

export type FlowInvokeClientOptions = Readonly<{
  address: FlowApplicationAddress;
  /** Current address and declared control values, sampled when each request is sent. */
  pageInputs?: () => Readonly<{
    parameters: Readonly<Record<string, string | readonly string[]>>;
    controls: Readonly<Record<string, string>>;
  }>;
  subject?: FlowSubjectContext;
  endpoint?: string;
  /** Snapshot the visible placements for this request and apply its reply before flow intents. */
  prepareRefresh?: (bindingId: string) =>
    | Readonly<{
        request: unknown;
        apply: (result: unknown) => void;
      }>
    | undefined;
  fetchImplementation?: typeof fetch;
}>;

const unavailable: ServerFlowResponse = Object.freeze({ kind: "unavailable" });
const unknown: ServerFlowResponse = Object.freeze({ kind: "unknown" });
const refused: ServerFlowResponse = Object.freeze({ kind: "refused" });
const invalidServerResponse = (cause: unknown = new TypeError("FLOW_SERVER_RESPONSE_INVALID")) => {
  console.error(`[flow] server response invalid: ${describeFailure(cause)}`);
  return unknown;
};

/** Exactly a committed save's authored warning: its task and a non-blank message. */
const isWarningNotice = (candidate: unknown): candidate is FlowWarningNotice =>
  isRecord(candidate) &&
  Object.keys(candidate).length === 2 &&
  typeof candidate.taskId === "string" &&
  typeof candidate.message === "string" &&
  candidate.message.length > 0;

const isCarriedValues = (candidate: unknown): candidate is string | undefined =>
  candidate === undefined ||
  (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 65_536);

/** Fails closed: anything that is not exactly one of the endpoint's answers has an unknown outcome. */
export const parseServerFlowResponse = (candidate: unknown): ServerFlowResponse => {
  if (!isRecord(candidate)) return invalidServerResponse();
  switch (candidate.kind) {
    case "run_opened":
      return isCarriedValues(candidate.carriedValues) && candidate.carriedValues !== undefined
        ? { kind: "run_opened", carriedValues: candidate.carriedValues }
        : invalidServerResponse();
    case "refused":
      return refused;
    case "unavailable":
      return unavailable;
    case "cells_refused": {
      const problems = recordsTableBatchEditProblemSchema
        .array()
        .min(1)
        .max(1000)
        .safeParse(candidate.problems);
      return problems.success
        ? { kind: "cells_refused", problems: problems.data }
        : invalidServerResponse();
    }
    case "reload":
      return typeof candidate.installationRevision === "number"
        ? { kind: "reload", installationRevision: candidate.installationRevision }
        : invalidServerResponse();
    case "result": {
      const warnings = candidate.warnings;
      if (!Array.isArray(warnings) || !warnings.every(isWarningNotice))
        return invalidServerResponse();
      const descriptor = candidate.descriptor;
      if (
        typeof candidate.runId !== "string" ||
        !isRecord(descriptor) ||
        typeof descriptor.outcome !== "string" ||
        typeof descriptor.commit !== "string" ||
        typeof descriptor.outputs !== "string" ||
        typeof descriptor.recovery !== "string" ||
        !isRecord(candidate.outputs) ||
        (candidate.stopped !== undefined && typeof candidate.stopped !== "string") ||
        !isCarriedValues(candidate.carriedValues)
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
        ...(candidate.stopped === undefined ? {} : { stopped: candidate.stopped as string }),
        ...(candidate.carriedValues === undefined
          ? {}
          : { carriedValues: candidate.carriedValues }),
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
 * server. Each request runs exactly one server segment of a flow the page runner drives.
 */
export function createFlowInvokeClient(options: FlowInvokeClientOptions): FlowInvokeClient {
  const endpoint = options.endpoint ?? "/api/flows/invoke";
  const send = async (
    invocation: FlowBindingInvocation,
    signal?: AbortSignal,
    bindingId?: string,
  ): Promise<ServerFlowResponse> => {
    if (signal?.aborted) return unavailable;
    try {
      const refresh = bindingId === undefined ? undefined : options.prepareRefresh?.(bindingId);
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
          ...(refresh === undefined ? {} : { refresh: refresh.request }),
          invocation,
        }),
      });
      if (response.status === 401 || response.status === 403 || response.status === 413)
        return refused;
      const body: unknown = await response.json();
      if (signal?.aborted) return unavailable;
      const parsed = parseServerFlowResponse(body);
      if (isRecord(body) && body.refresh !== undefined) {
        if (refresh === undefined || parsed.kind !== "result")
          return invalidServerResponse();
        refresh.apply(body.refresh);
      }
      return parsed;
    } catch (error) {
      if (signal?.aborted) return unavailable;
      console.error(`[flow] invoke request failed: ${describeFailure(error)}`);
      return unknown;
    }
  };
  return Object.freeze({
    openRun: (binding, clickId, signal, sourceTablePlacementId) =>
      send(
        {
          kind: "run_start",
          bindingId: binding.bindingId,
          flowId: binding.flowId,
          entrySegments: [...binding.entrySegments],
          clickId,
          ...(sourceTablePlacementId === undefined ? {} : { sourceTablePlacementId }),
        },
        signal,
      ),
    startBinding: (
      binding,
      callerInputs,
      clickId,
      signal,
      subject,
      sourceTablePlacementId,
      carriedValues,
      segmentValues,
    ) =>
      send(
        {
          kind: "binding",
          bindingId: binding.bindingId,
          flowId: binding.flowId,
          entrySegments: [...binding.entrySegments],
          segment: segmentValues.segment,
          clickId,
          seed: segmentValues.seed,
          iteration: segmentValues.iteration,
          ...(segmentValues.phase === undefined ? {} : { phase: segmentValues.phase }),
          callerInputs,
          ...(carriedValues === undefined ? {} : { carriedValues }),
          ...(sourceTablePlacementId === undefined ? {} : { sourceTablePlacementId }),
          ...((subject ?? options.subject) === undefined
            ? {}
            : { subject: subject ?? options.subject }),
        },
        signal,
        binding.bindingId,
      ),
  });
}
