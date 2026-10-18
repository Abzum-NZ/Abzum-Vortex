import {
  maximumFlowConfirmationDetailLines,
  type FormContinuationAnswer,
  type JsonValue,
} from "@vortex/platform/schema";

/**
 * One typed interface intent, as the shared interpreter produces it in the page or the server
 * orchestrator returns it. Properties are plain JSON; nothing here is evaluated as text.
 */
export type FlowIntent = Readonly<{
  kind:
    "show_message" | "show_form" | "confirm" | "navigate" | "refresh" | "set_panel" | "set_filter";
  taskId: string;
  properties: Readonly<Record<string, JsonValue>>;
}>;

export type FlowIntentKind = FlowIntent["kind"];

export const FLOW_INTENT_KINDS: readonly FlowIntentKind[] = Object.freeze([
  "show_message",
  "show_form",
  "confirm",
  "navigate",
  "refresh",
  "set_panel",
  "set_filter",
]);

/** The person's answer to a form intent, using the same shape sent to the server. */
export type FlowFormAnswer = Extract<FormContinuationAnswer, { kind: "submit" | "cancel" }>;

export type FlowMessageIntent = Readonly<{ text: string; tone: string | undefined }>;
/**
 * A confirmation: its question, what it covers line by line, and one optional opt-in that goes with
 * a yes. `confirmLabel` names the answering button.
 */
export type FlowConfirmIntent = Readonly<{
  title: string | undefined;
  message: string;
  details: readonly string[];
  choice: string | undefined;
  confirmLabel: string | undefined;
  destructive: boolean | undefined;
}>;
/** The person's answer to a confirmation; `choice` is set only when one was offered. */
export type FlowConfirmAnswer = Readonly<{ confirmed: boolean; choice?: boolean }>;
export type FlowFormIntent = Readonly<{
  taskId: string;
  formId: string;
  inputs: Readonly<Record<string, JsonValue>>;
}>;

const maximumTextLength = 2_000;

const text = (candidate: JsonValue | undefined): string | undefined =>
  typeof candidate === "string" && candidate.length > 0 && candidate.length <= maximumTextLength
    ? candidate
    : undefined;

const record = (candidate: JsonValue | undefined): Readonly<Record<string, JsonValue>> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate : {};

export const isFlowIntent = (candidate: unknown): candidate is FlowIntent => {
  if (typeof candidate !== "object" || candidate === null) return false;
  const intent = candidate as Record<string, unknown>;
  return (
    FLOW_INTENT_KINDS.includes(intent.kind as FlowIntentKind) &&
    typeof intent.taskId === "string" &&
    typeof intent.properties === "object" &&
    intent.properties !== null &&
    !Array.isArray(intent.properties)
  );
};

/** Undefined when the intent lacks its required, bounded message text. */
export const readMessageIntent = (intent: FlowIntent): FlowMessageIntent | undefined => {
  const message = text(intent.properties.message);
  return message === undefined ? undefined : { text: message, tone: text(intent.properties.tone) };
};

/**
 * A bounded number of complete review entries, or none. An entry can describe a role's entire
 * permission set and field changes, so it must not inherit the short message-text limit.
 */
const detailLines = (candidate: JsonValue | undefined): readonly string[] | undefined => {
  if (candidate === undefined || candidate === null) return [];
  if (!Array.isArray(candidate) || candidate.length > maximumFlowConfirmationDetailLines)
    return undefined;
  const lines = candidate.map((line) =>
    typeof line === "string" && line.length > 0 ? line : undefined,
  );
  return lines.every((line): line is string => line !== undefined) ? lines : undefined;
};

/** Undefined when the message is missing or the review entries are not a bounded list of texts. */
export const readConfirmIntent = (intent: FlowIntent): FlowConfirmIntent | undefined => {
  const message = text(intent.properties.message);
  const details = detailLines(intent.properties.details);
  return message === undefined || details === undefined
    ? undefined
    : {
        title: text(intent.properties.title),
        message,
        details,
        choice: text(intent.properties.choice),
        confirmLabel: text(intent.properties.confirm_label),
        destructive:
          typeof intent.properties.destructive === "boolean"
            ? intent.properties.destructive
            : undefined,
      };
};

/** The resume answer for a confirmation, carrying the opt-in only when one was offered. */
export const confirmAnswer = (
  confirmation: FlowConfirmIntent,
  answer: FlowConfirmAnswer,
): Extract<FormContinuationAnswer, { kind: "confirm" }> => ({
  kind: "confirm",
  confirmed: answer.confirmed,
  ...(confirmation.choice === undefined
    ? {}
    : { choice: answer.confirmed && answer.choice === true }),
});

export const readFormIntent = (intent: FlowIntent): FlowFormIntent | undefined => {
  const formId = text(intent.properties.form);
  return formId === undefined
    ? undefined
    : { taskId: intent.taskId, formId, inputs: record(intent.properties.inputs) };
};

/**
 * What the page does for each intent. Message, form, confirm and navigate are required; the other
 * presentation intents are skipped when the shell does not supply them.
 */
export type FlowIntentHost = Readonly<{
  showMessage: (message: FlowMessageIntent, signal?: AbortSignal) => void | Promise<void>;
  /** Resolves with the person's answer; a rejection abandons the run without answering. */
  showForm: (form: FlowFormIntent, signal?: AbortSignal) => Promise<FlowFormAnswer>;
  confirm: (confirmation: FlowConfirmIntent, signal?: AbortSignal) => Promise<FlowConfirmAnswer>;
  navigate: (intent: FlowIntent) => boolean | Promise<boolean>;
  refresh?: (component: string | undefined) => void | Promise<void>;
  setPanel?: (panel: string, state: string) => void | Promise<void>;
  setFilter?: (
    component: string,
    field: string,
    value: JsonValue | undefined,
  ) => void | Promise<void>;
}>;

/** Carries out one non-blocking intent (never a form or confirmation). */
export async function performPresentationIntent(
  intent: FlowIntent,
  host: FlowIntentHost,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  switch (intent.kind) {
    case "show_message": {
      const message = readMessageIntent(intent);
      if (message !== undefined) await host.showMessage(message, signal);
      return;
    }
    case "navigate":
      await host.navigate(intent);
      return;
    case "refresh":
      await host.refresh?.(text(intent.properties.component));
      return;
    case "set_panel": {
      const panel = text(intent.properties.panel);
      const state = text(intent.properties.state);
      if (panel !== undefined && state !== undefined) await host.setPanel?.(panel, state);
      return;
    }
    case "set_filter": {
      const component = text(intent.properties.component);
      const field = text(intent.properties.field);
      if (component !== undefined && field !== undefined)
        await host.setFilter?.(component, field, intent.properties.value);
      return;
    }
    default:
      return;
  }
}
