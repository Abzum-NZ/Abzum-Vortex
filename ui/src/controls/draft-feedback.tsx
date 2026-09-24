"use client";

import type { ReactElement } from "react";
import { useFormScope } from "./form-context";
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

/** Located feedback applicable to one field, or nothing when none applies. */
export type FormFieldDraftFeedback = Readonly<{
  required: boolean;
  disabled: boolean;
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
 * One field's located draft feedback. It is a polite live region, so a message
 * that appears later is announced without interrupting, and its control
 * references it through `aria-describedby`. It renders nothing when no feedback
 * applies, so a corrected draft produces no stale text.
 */
export function FieldDraftFeedback({
  id,
  feedback,
}: Readonly<{ id: string; feedback: FormFieldDraftFeedback | undefined }>): ReactElement | null {
  if (feedback === undefined) return null;
  const notes: ReactElement[] = [];
  if (feedback.required)
    notes.push(
      <span key="required" className="vortex-draft-feedback-required">
        Required
      </span>,
    );
  if (feedback.disabled)
    notes.push(
      <span key="disabled" className="vortex-draft-feedback-disabled">
        Not editable
      </span>,
    );
  feedback.messages.forEach((message, index) => {
    notes.push(
      <span key={`message-${index}`} className={`vortex-draft-feedback-${message.severity}`}>
        {message.text}
      </span>,
    );
  });
  return (
    <span
      id={id}
      role="status"
      data-vortex-draft-feedback="field"
      className="vortex-draft-feedback"
    >
      {notes}
    </span>
  );
}

/**
 * Form-level draft feedback for warnings and for a refusal no control owns. It
 * stays mounted while empty so a later message is announced politely. It is
 * separate from the form's projected operation outcomes and, being display
 * only, can never resubmit an operation or report a rollback.
 */
export function FormDraftFeedbackRegion({
  id,
  summary,
}: Readonly<{ id: string; summary: FormDraftFeedbackSummary | undefined }>): ReactElement {
  const messages = summary?.messages ?? [];
  return (
    <div
      id={id}
      role="status"
      data-vortex-draft-feedback="form"
      className="vortex-draft-feedback-summary"
    >
      {messages.map((message, index) => (
        <p key={index} className={`vortex-draft-feedback-${message.severity}`}>
          {message.text}
        </p>
      ))}
    </div>
  );
}
