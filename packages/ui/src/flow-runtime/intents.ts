import {
  maximumFlowConfirmationDetailLines,
  flowMessageDismissBounds,
  flowMessageSeverities,
  flowMessageTargets,
  type FlowMessageSeverity,
  type FlowMessageTarget,
  type FormAnswer,
  type JsonValue,
} from "@vortex/platform/schema";
import type { NoticeSeverity } from "../components/notice";
import type { PageMessageTarget } from "./messages";
import type { FlowSubjectContext } from "./server-flow-client";

/**
 * One typed interface intent, as the shared interpreter produces it in the page or the server
 * orchestrator returns it. Properties are plain JSON; nothing here is evaluated as text.
 */
export type FlowIntent = Readonly<{
  kind:
    | "show_message"
    | "clear_message"
    | "show_form"
    | "confirm"
    | "navigate"
    | "refresh"
    | "set_panel"
    | "set_filter"
    | "set_value"
    | "validate_form";
  taskId: string;
  properties: Readonly<Record<string, JsonValue>>;
}>;

export type FlowIntentKind = FlowIntent["kind"];

/**
 * The person's answer to a form intent, using the same shape sent to the server. Cancel is an
 * answer: the run resumes and the flow's own `submitted` branch decides what a cancel means.
 */
export type FlowFormAnswer = Extract<FormAnswer, { kind: "submit" | "cancel" }>;

/**
 * The one rejection of an interactive surface that went away unanswered: the page unmounted or the
 * caller's signal aborted. The run is abandoned and no answer is sent.
 */
export const surfaceCancellationError = (): Error => {
  const error = new Error("Flow surface cancelled");
  error.name = "AbortError";
  return error;
};

export const isSurfaceCancellation = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

/** A message's evaluated presentation and optional action. */
export type FlowMessageIntent = Readonly<{
  taskId?: string;
  target: PageMessageTarget;
  component?: string;
  text: string;
  severity: NoticeSeverity;
  title?: string;
  actionLabel?: string;
  actionFlow?: string;
  actionInputs?: Readonly<Record<string, JsonValue>>;
  dismissAfterMs?: number;
  originBindingId?: string;
  sourceFlowId?: string;
  subject?: FlowSubjectContext;
  sourceTablePlacementId?: string;
}>;
/** One review line, or a role line with the lines that belong under it. */
// item 10: CRM-FIX-PLATFORM
export type FlowConfirmationDetail = string | Readonly<{ text: string; lines: readonly string[] }>;
/**
 * A confirmation: its question, what it covers line by line, and one optional opt-in that goes with
 * a yes. `confirmLabel` names the answering button.
 */
export type FlowConfirmIntent = Readonly<{
  title: string | undefined;
  message: string;
  details: readonly FlowConfirmationDetail[];
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

/** Undefined when a platform-produced intent does not match the message contract. */
export const readMessageIntent = (intent: FlowIntent): FlowMessageIntent | undefined => {
  const message = text(intent.properties.message);
  const title = text(intent.properties.title);
  const target = text(intent.properties.target);
  const severity = text(intent.properties.severity);
  const component = text(intent.properties.component);
  const actionLabel = text(intent.properties.action_label);
  const actionFlow = text(intent.properties.action_flow);
  const actionInputs = intent.properties.action_inputs;
  const dismissAfterMs = intent.properties.dismiss_after_ms;
  if (
    message === undefined ||
    target === undefined ||
    !(flowMessageTargets as readonly string[]).includes(target) ||
    severity === undefined ||
    !(flowMessageSeverities as readonly string[]).includes(severity) ||
    ((target === "inline" || target === "slot") && component === undefined) ||
    (actionLabel === undefined) !== (actionFlow === undefined) ||
    (actionInputs !== undefined &&
      (typeof actionInputs !== "object" || actionInputs === null || Array.isArray(actionInputs))) ||
    (dismissAfterMs !== undefined &&
      (typeof dismissAfterMs !== "number" ||
        !Number.isInteger(dismissAfterMs) ||
        dismissAfterMs < flowMessageDismissBounds.minimumMs ||
        dismissAfterMs > flowMessageDismissBounds.maximumMs ||
        (target !== "toast" && target !== "banner") ||
        (severity !== "info" && severity !== "success")))
  )
    return undefined;
  return {
    taskId: intent.taskId,
    target: target as FlowMessageTarget,
    text: message,
    severity: severity as FlowMessageSeverity,
    ...(title === undefined ? {} : { title }),
    ...(component === undefined ? {} : { component }),
    ...(actionLabel === undefined ? {} : { actionLabel }),
    ...(actionFlow === undefined ? {} : { actionFlow }),
    ...(actionInputs === undefined
      ? {}
      : { actionInputs: actionInputs as Readonly<Record<string, JsonValue>> }),
    ...(dismissAfterMs === undefined ? {} : { dismissAfterMs: dismissAfterMs as number }),
  };
};

/**
 * A bounded number of complete review entries, or none. An entry can describe a role's entire
 * permission set and field changes, so it must not inherit the short message-text limit. A role
 * entry carries the role line and the lines that belong under it.
 */
// item 10: CRM-FIX-PLATFORM
const detailEntries = (
  candidate: JsonValue | undefined,
): readonly FlowConfirmationDetail[] | undefined => {
  if (candidate === undefined || candidate === null) return [];
  // item 10: CRM-FIX-PLATFORM
  if (!Array.isArray(candidate) || candidate.length > maximumFlowConfirmationDetailLines)
    return undefined;
  const details: FlowConfirmationDetail[] = [];
  for (const entry of candidate) {
    if (typeof entry === "string" && entry.length > 0) {
      details.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const text = entry.text;
    const lines = entry.lines;
    // item 10: CRM-FIX-PLATFORM
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      !Array.isArray(lines) ||
      lines.length > maximumFlowConfirmationDetailLines ||
      !lines.every((line): line is string => typeof line === "string" && line.length > 0)
    )
      return undefined;
    details.push({ text, lines });
  }
  return details;
};

const detailLines = (
  candidate: JsonValue | undefined,
): readonly FlowConfirmationDetail[] | undefined => detailEntries(candidate);

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
): Extract<FormAnswer, { kind: "confirm" }> => ({
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
  clearMessage?: (target: PageMessageTarget, component?: string) => void;
  /** Resolves with the person's answer; a surface that went away (`isSurfaceCancellation`) abandons the run unanswered. */
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
  setPageValues?: (values: Readonly<Record<string, JsonValue>>) => void;
  setFormValue?: (form: string, field: string, value: JsonValue) => boolean;
  /** Shows the form's field problems and answers whether it is valid. */
  validateForm?: (form: string) => boolean;
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
      if (message === undefined) throw new Error("FLOW_MESSAGE_INTENT_INVALID");
      await host.showMessage(message, signal);
      return;
    }
    case "clear_message": {
      const target = text(intent.properties.target);
      const component = text(intent.properties.component);
      if (
        !target ||
        !["toast", "banner", "dialog", "inline", "slot"].includes(target) ||
        ((target === "inline" || target === "slot") && component === undefined) ||
        host.clearMessage === undefined
      )
        throw new Error("FLOW_CLEAR_MESSAGE_INTENT_INVALID");
      host.clearMessage(target as PageMessageTarget, component);
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
    case "set_value": {
      const form = text(intent.properties.form);
      const field = text(intent.properties.field);
      if (form !== undefined && field !== undefined && Object.hasOwn(intent.properties, "to")) {
        if (host.setFormValue?.(form, field, intent.properties.to!) !== true)
          throw new Error("FLOW_FORM_FIELD_WRITE_REFUSED");
        return;
      }
      const values = intent.properties.values;
      if (
        typeof values !== "object" ||
        values === null ||
        Array.isArray(values) ||
        host.setPageValues === undefined
      )
        throw new Error("FLOW_PAGE_VALUES_UNAVAILABLE");
      host.setPageValues(values);
      return;
    }
    case "validate_form": {
      const form = text(intent.properties.form);
      if (form === undefined || host.validateForm === undefined)
        throw new Error("FLOW_VALIDATE_FORM_UNAVAILABLE");
      // An invalid form stops the flow: its problems are shown on the form, so the run ends unanswered.
      if (!host.validateForm(form)) throw surfaceCancellationError();
      return;
    }
    default:
      return;
  }
}
