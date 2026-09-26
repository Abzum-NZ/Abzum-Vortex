import type { JsonValue } from "@vortex/contracts";
import {
  performPresentationIntent,
  readConfirmIntent,
  readFormIntent,
  type FlowIntent,
  type FlowIntentHost,
} from "./intents";
import type { FlowInvokeClient, ServerFlowResponse } from "./server-flow-client";

export type ServerDrivenResult =
  /** The server ended the run; `descriptor` is its safe result and outputs are as it released them. */
  | Readonly<{
      kind: "finished";
      runId: string;
      descriptor: Extract<ServerFlowResponse, { kind: "result" }>["descriptor"];
      outputs: Readonly<Record<string, JsonValue>>;
      failure?: Readonly<{ code: string; taskId?: string }>;
    }>
  /** The surface is older than the installation: nothing ran and the page must reload. */
  | Readonly<{ kind: "reload"; installationRevision: number }>
  /** Unknown, expired, foreign, tampered or not permitted: the one neutral refusal. */
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>
  /** The surface went away before answering; no answer was sent. */
  | Readonly<{ kind: "abandoned" }>;

const minimumContinuationLength = 16;
const maximumContinuationLength = 128;
const maximumRounds = 25;

const expectedIntentKind = { form: "show_form", confirm: "confirm" } as const;

/**
 * Carries out a server-driven flow in the page. The server runs every task from the first one; at a
 * form or confirmation it returns typed intents and a single-use continuation. The page shows the
 * intents and sends back only the continuation exactly as issued together with the person's
 * answer. It never chooses a path, never reuses a continuation and never resumes a run whose intent
 * does not match what the server said it awaits; the server re-checks everything on resume.
 */
export async function driveServerFlow(
  client: FlowInvokeClient,
  flowId: string,
  first: ServerFlowResponse,
  host: FlowIntentHost,
): Promise<ServerDrivenResult> {
  let response = first;
  try {
    for (let round = 0; round < maximumRounds; round += 1) {
      switch (response.kind) {
        case "reload":
        case "refused":
        case "unavailable":
          return response;
        case "result": {
          for (const intent of response.intents) await performPresentationIntent(intent, host);
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
            return { kind: "refused" };
          for (const intent of response.intents.slice(0, -1))
            if (intent.kind === "show_form" || intent.kind === "confirm")
              return { kind: "refused" };
            else await performPresentationIntent(intent, host);

          const continuation = response.continuation;
          if (response.awaiting === "form") {
            const form = readFormIntent(waiting);
            if (form === undefined) return { kind: "refused" };
            const answer = await host.showForm(form);
            response = await client.resume(flowId, continuation, {
              kind: "form_answered",
              submitted: answer.submitted,
              values: answer.submitted ? answer.values : null,
            });
          } else {
            const confirmation = readConfirmIntent(waiting);
            if (confirmation === undefined) return { kind: "refused" };
            response = await client.resume(flowId, continuation, {
              kind: "confirmed",
              confirmed: await host.confirm(confirmation),
            });
          }
          break;
        }
      }
    }
    return { kind: "refused" };
  } catch {
    return { kind: "abandoned" };
  }
}
