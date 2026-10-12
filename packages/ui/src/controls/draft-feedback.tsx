"use client";

import type { ReactElement } from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/alert";
import { equalFormValue, useFormScope } from "./form-context";
import type { TypedFieldValue } from "./projected-data";

/**
 * #591: accessible presentation of located draft feedback.
 *
 * The page projection computes one #590 `RuleDraftFeedbackProjection` from an
 * exact draft and supplies it to the form. This layer never evaluates a rule,
 * maps a permanent field identity, performs a final save validation or calls an
 * operation: it locates each supplied message on the form's own field key,
 * attaches it to that control's accessible description and keeps the feedback
 * structurally separate from committed, partial and pending operation outcomes.
 * A supplied result is applied only for the exact draft it was computed from;
 * any later local edit discards it until a fresh result arrives.
 */

/** One located requirement, warning or refusal message. */
export type FormDraftFeedbackMessage = Readonly<{
  severity: "error" | "warning";
  text: string;
}>;

/** Located required, visible and disabled state for one form field in the draft. */
export type FormDraftFeedbackFieldState = Readonly<{
  fieldKey: string;
  required: boolean;
  disabled: boolean;
  visible: boolean;
}>;

/**
 * Located requirement messages, form-level warnings and an optional refusal for
 * one exact draft. Every entry is already located on the form's own declared
 * field key by the supplying projection; this layer never remaps a field
 * identity and never invents authority from an input.
 */
export type FormDraftFeedback = Readonly<{
  /** Exact draft fingerprint this feedback was computed from. */
  fingerprint: string;
  fields: readonly FormDraftFeedbackFieldState[];
  requirements: readonly Readonly<{ fieldKey: string; message: string }>[];
  warnings: readonly string[];
  refusal?: Readonly<{ message: string; fieldKey?: string }>;
}>;

/**
 * One supplied feedback result. `currentFingerprint` is the fingerprint of the
 * draft the form shows now; when it differs from `feedback.fingerprint` the
 * result is late or out of order and is discarded. `values` are the typed draft
 * values the projection used, keyed by the form's field key; the form compares
 * them to the current field values and discards feedback once a value diverges,
 * so an obsolete requirement, visibility or warning never stays on screen.
 */
export type FormDraftFeedbackSupply = Readonly<{
  currentFingerprint: string;
  values: Readonly<Record<string, TypedFieldValue>>;
  feedback: FormDraftFeedback;
}>;

/**
 * Located feedback applicable to one field, or nothing when none applies. A
 * hidden field stays mounted, so its typed value is kept; its messages move to
 * the form-level summary because a person cannot act on a hidden control.
 */
export type FormFieldDraftFeedback = Readonly<{
  required: boolean;
  disabled: boolean;
  hidden: boolean;
  messages: readonly FormDraftFeedbackMessage[];
}>;

/** Form-level feedback that no control owns. */
export type FormDraftFeedbackSummary = Readonly<{
  messages: readonly FormDraftFeedbackMessage[];
}>;

/** The located draft feedback applicable to one field, read from the enclosing form. */
export function useFieldFeedback(fieldKey: string): FormFieldDraftFeedback | undefined {
  const scope = useFormScope();
  return scope?.draftFeedbackFor(fieldKey);
}

/**
 * The supplied feedback when it describes the draft the form shows now, or
 * nothing. A late or out-of-order fingerprint, or any placed field whose typed
 * value differs from the values the result was computed from, discards it.
 */
export const applicableDraftFeedback = (
  supply: FormDraftFeedbackSupply | undefined,
  current: Readonly<Record<string, TypedFieldValue>>,
): FormDraftFeedback | undefined => {
  if (supply === undefined) return undefined;
  if (supply.feedback.fingerprint !== supply.currentFingerprint) return undefined;
  for (const [fieldKey, expected] of Object.entries(supply.values)) {
    if (!Object.prototype.hasOwnProperty.call(current, fieldKey)) continue;
    if (!equalFormValue(current[fieldKey], expected)) return undefined;
  }
  return supply.feedback;
};

const fieldMessages = (
  feedback: FormDraftFeedback,
  fieldKey: string,
): FormDraftFeedbackMessage[] => {
  const messages: FormDraftFeedbackMessage[] = feedback.requirements
    .filter((requirement) => requirement.fieldKey === fieldKey)
    .map((requirement) => ({ severity: "error" as const, text: requirement.message }));
  if (feedback.refusal !== undefined && feedback.refusal.fieldKey === fieldKey)
    messages.push({ severity: "error", text: feedback.refusal.message });
  return messages;
};

/** The located state and messages one field's control presents, or nothing. */
export const fieldDraftFeedback = (
  feedback: FormDraftFeedback | undefined,
  fieldKey: string,
): FormFieldDraftFeedback | undefined => {
  if (feedback === undefined) return undefined;
  const state = feedback.fields.find((field) => field.fieldKey === fieldKey);
  const hidden = state !== undefined && !state.visible;
  const required = state?.required === true;
  const disabled = state?.disabled === true;
  const messages = hidden ? [] : fieldMessages(feedback, fieldKey);
  if (!hidden && !required && !disabled && messages.length === 0) return undefined;
  return { required, disabled, hidden, messages };
};

/**
 * Form-level feedback: every warning, plus any requirement or refusal whose
 * field has no visible control in this form, so no located message is lost.
 */
export const formDraftFeedbackSummary = (
  feedback: FormDraftFeedback | undefined,
  placedFieldKeys: ReadonlySet<string>,
): FormDraftFeedbackSummary | undefined => {
  if (feedback === undefined) return undefined;
  const presented = (fieldKey: string | undefined): boolean =>
    fieldKey !== undefined &&
    placedFieldKeys.has(fieldKey) &&
    fieldDraftFeedback(feedback, fieldKey)?.hidden !== true;
  const messages: FormDraftFeedbackMessage[] = feedback.warnings.map((text) => ({
    severity: "warning" as const,
    text,
  }));
  for (const requirement of feedback.requirements)
    if (!presented(requirement.fieldKey))
      messages.push({ severity: "error", text: requirement.message });
  if (feedback.refusal !== undefined && !presented(feedback.refusal.fieldKey))
    messages.push({ severity: "error", text: feedback.refusal.message });
  return messages.length === 0 ? undefined : { messages };
};

/**
 * One field's located draft feedback. It is a polite live region that stays
 * mounted while empty, so a message that appears later is announced without
 * interrupting, and its control references it through `aria-describedby` only
 * while it has content. It empties when no feedback applies, so a corrected
 * draft leaves no stale text.
 */
export function FieldDraftFeedback({
  id,
  feedback,
}: Readonly<{ id: string; feedback: FormFieldDraftFeedback | undefined }>): ReactElement {
  const notes: ReactElement[] = [];
  if (feedback?.required === true)
    notes.push(
      <span
        key="required"
        data-vortex-draft-feedback-required
        className="text-sm text-muted-foreground"
      >
        Required
      </span>,
    );
  if (feedback?.disabled === true)
    notes.push(
      <span
        key="disabled"
        data-vortex-draft-feedback-disabled
        className="text-sm text-muted-foreground"
      >
        Not editable
      </span>,
    );
  feedback?.messages.forEach((message, index) => {
    notes.push(
      <span
        key={`message-${index}`}
        data-vortex-draft-feedback-severity={message.severity}
        className={
          message.severity === "error" ? "text-sm text-destructive" : "text-sm text-foreground"
        }
      >
        {message.text}
      </span>,
    );
  });
  return (
    <span
      id={id}
      role="status"
      data-vortex-draft-feedback="field"
      className="flex flex-col gap-0.5"
    >
      {notes}
    </span>
  );
}

/**
 * Form-level draft feedback for warnings and for any requirement or refusal no
 * visible control in the form presents. It stays mounted while empty so a later
 * message is announced politely. It is separate from the form's projected
 * operation outcomes and, being display only, can never resubmit an operation
 * or report a rollback.
 */
export function FormDraftFeedbackRegion({
  id,
  summary,
}: Readonly<{ id: string; summary: FormDraftFeedbackSummary | undefined }>): ReactElement {
  const messages = summary?.messages ?? [];
  return (
    <div id={id} role="status" data-vortex-draft-feedback="form" className="flex flex-col gap-2">
      {messages.map((message, index) => (
        <Alert
          key={index}
          role="none"
          data-vortex-draft-feedback-severity={message.severity}
          variant={message.severity === "error" ? "destructive" : "default"}
        >
          <AlertTitle>{message.severity === "error" ? "Error" : "Warning"}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
