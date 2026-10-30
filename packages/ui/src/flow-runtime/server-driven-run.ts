import { describeFailure, type JsonValue } from "@vortex/platform/schema";
import {
  isSurfaceCancellation,
  readMessageIntent,
  type FlowIntent,
  type FlowIntentHost,
} from "./intents";
import { performPageFlowIntent } from "./page-step-implementations";
import type {
  FlowInvokeClient,
  FlowResumeEvidence,
  ServerFlowResponse,
} from "./server-flow-client";

export type ServerDrivenResult =
  /** The binding condition did not hold, so its flow was not started. */
  | Readonly<{ kind: "skipped" }>
  /** The server ended the run; `descriptor` is its safe result and outputs are as it released them. */
  | Readonly<{
      kind: "finished";
      runId: string;
      descriptor: Extract<ServerFlowResponse, { kind: "result" }>["descriptor"];
      outputs: Readonly<Record<string, JsonValue>>;
      failure?: Extract<ServerFlowResponse, { kind: "result" }>["failure"];
    }>
  /** The surface is older than the installation: nothing ran and the page must reload. */
  | Readonly<{ kind: "reload"; installationRevision: number }>
  /** Unknown, expired, foreign, tampered or not permitted: the one neutral refusal. */
  | Readonly<{ kind: "refused"; reason?: string }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "unknown"; controlId?: string; retry?: () => Promise<ServerDrivenResult> }>
  /**
   * The intent surface or caller went away before the run finished. `unanswered` is true when it
   * went away at a pause before any answer was sent, so this interaction sent nothing after the start;
   * otherwise an answer was sent or a result arrived and what the run committed is not known here.
   */
  | Readonly<{ kind: "abandoned"; unanswered: boolean }>;

const minimumContinuationLength = 16;
const maximumContinuationLength = 128;
const maximumRounds = 25;

const expectedIntentKind = { form: "show_form", confirm: "confirm" } as const;
const refuseInvalidServerFlowState = (stage: string): Readonly<{ kind: "refused" }> => {
  console.error(`[flow] server response invalid: stage=${stage}`);
  return { kind: "refused" };
};

/**
 * Carries out a server-driven flow in the page. The server runs every task from the first one; at a
 * form or confirmation it returns typed intents and a single-use continuation. The page shows the
 * intents and sends back only the continuation exactly as issued together with the person's
 * answer. It never chooses a path, never reuses a continuation and never resumes a run whose intent
 * does not match what the server said it awaits; the server re-checks everything on resume. When
 * the run committed, the reply itself carries the refreshed rows (see the client's refresh).
 */
export async function driveServerFlow(
  client: FlowInvokeClient,
  flowId: string,
  first: ServerFlowResponse,
  host: FlowIntentHost,
  signal?: AbortSignal,
  sourceTablePlacementId?: string,
  bindingId?: string,
): Promise<ServerDrivenResult> {
  let response = first;
  let awaitingSurface = false;
  let answerSent = false;
  const abandoned = (): ServerDrivenResult => ({
    kind: "abandoned",
    unanswered: !answerSent && response.kind === "intent",
  });
  try {
    for (let round = 0; round < maximumRounds; round += 1) {
      if (signal?.aborted) return abandoned();
      switch (response.kind) {
        case "run_opened":
          return refuseInvalidServerFlowState("unexpected_run_start");
        case "reload":
        case "refused":
        case "unavailable":
        case "unknown":
          return response;
        case "result": {
          for (const intent of response.intents) {
            if (signal?.aborted) return abandoned();
            // A success message of a run that ended refused or failed described an outcome that
            // did not happen; the page tells the person why it ended instead.
            if (
              response.failure !== undefined &&
              intent.kind === "show_message" &&
              readMessageIntent(intent)?.severity === "success"
            )
              continue;
            await performPageFlowIntent(intent, host, signal);
          }
          return {
            kind: "finished",
            runId: response.runId,
            descriptor: response.descriptor,
            outputs: response.outputs,
            ...(response.failure === undefined ? {} : { failure: response.failure }),
          };
        }
        case "intent": {
          const waiting: FlowIntent | undefined = response.intents.at(-1);
          if (
            waiting === undefined ||
            waiting.kind !== expectedIntentKind[response.awaiting] ||
            response.continuation.length < minimumContinuationLength ||
            response.continuation.length > maximumContinuationLength
          )
            return refuseInvalidServerFlowState("continuation_intent");
          for (const intent of response.intents.slice(0, -1))
            if (intent.kind === "show_form" || intent.kind === "confirm")
              return refuseInvalidServerFlowState("unexpected_pause_intent");
            else {
              if (signal?.aborted) return abandoned();
              await performPageFlowIntent(intent, host, signal);
            }

          const continuation = response.continuation;
          // The exact evidence the server issued with this pause, sent back unchanged on resume; the
          // page never builds a target or receipt of its own.
          const evidence: FlowResumeEvidence = {
            target: response.target,
            ...(response.receipt === undefined ? {} : { receipt: response.receipt }),
          };
          awaitingSurface = true;
          const answer = await performPageFlowIntent(waiting, host, signal);
          awaitingSurface = false;
          if (answer === undefined)
            return refuseInvalidServerFlowState(`${response.awaiting}_intent`);
          if (signal?.aborted) return abandoned();
          answerSent = true;
          const carriedValues = response.carriedValues;
          const retryResume = async (): Promise<ServerDrivenResult> => {
            const retried = await client.resume(
              flowId,
              continuation,
              answer,
              evidence,
              undefined,
              sourceTablePlacementId,
              carriedValues,
              bindingId,
            );
            if (retried.kind === "unknown") return { kind: "unknown", retry: retryResume };
            return driveServerFlow(
              client,
              flowId,
              retried,
              host,
              undefined,
              sourceTablePlacementId,
              bindingId,
            );
          };
          response = await client.resume(
            flowId,
            continuation,
            answer,
            evidence,
            signal,
            sourceTablePlacementId,
            carriedValues,
            bindingId,
          );
          if (response.kind === "unknown") return { kind: "unknown", retry: retryResume };
          break;
        }
      }
    }
    return refuseInvalidServerFlowState("round_limit");
  } catch (error) {
    if (signal?.aborted) return abandoned();
    if (awaitingSurface && isSurfaceCancellation(error)) return abandoned();
    console.error(`[flow] server-driven execution failed: ${describeFailure(error)}`);
    return { kind: "unavailable" };
  }
}
