"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { DefinitionRenderError } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import { resolveControlContext } from "./control-context";
import {
  FormDraftFeedbackRegion,
  type FormDraftFeedback,
  type FormDraftFeedbackMessage,
  type FormDraftFeedbackSupply,
  type FormDraftFeedbackSummary,
  type FormFieldDraftFeedback,
} from "./draft-feedback";
import {
  createFormFieldRegistry,
  equalFormValue,
  FormScopeContext,
  useFormScope,
  type FormScope,
} from "./form-context";

/**
 * A form container accepts one supplied #590 draft-feedback result beside its
 * projected block props. The page projection supplies it; the control never
 * computes or reinterprets a rule itself.
 */
export type FormContainerProps = PlatformBlockRenderProps &
  Readonly<{ draftFeedback?: FormDraftFeedbackSupply }>;

/** Input types for which Enter is the form's default submission, as in native implicit submission. */
const NON_SUBMITTING_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "file",
  "image",
  "radio",
  "reset",
  "submit",
]);

const FIRST_FIELD_SELECTOR =
  "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";

/**
 * Accessible form boundary. It emits `form_ready` once when mounted, and one `form_submit` with
 * the typed values of its fields for Enter in a field or a Submit button; it never saves or
 * submits anywhere itself. Submission is refused while projected as pending or unavailable.
 * Reset emits `form_reset` and restores every field to its projected value. Nested forms and
 * two fields with one key fail closed.
 */
export function FormContainer(props: FormContainerProps): ReactElement {
  const context = resolveControlContext(props, "form", ["form_ready", "form_submit", "form_reset"]);
  if (useFormScope() !== undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A form container cannot be placed inside another form container",
      context.location,
    );

  const titleId = useId();
  const feedbackId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [generation, setGeneration] = useState(0);
  const [registry] = useState(() => createFormFieldRegistry(context.location));
  const [, setFeedbackTick] = useState(0);
  const supply = props.draftFeedback;
  // Rechecks settled feedback only while a result is supplied; without one a
  // keystroke must not re-render the whole form.
  const reportFieldChanged = useCallback(() => {
    if (supply !== undefined) setFeedbackTick((current) => current + 1);
  }, [supply]);

  // Feedback applies only to the exact draft it was computed from: a late
  // fingerprint, or any field whose typed value no longer matches the supplied
  // draft, discards it until the projection supplies a fresh result.
  const applicableFeedback = useCallback((): FormDraftFeedback | undefined => {
    if (supply === undefined) return undefined;
    if (supply.feedback.fingerprint !== supply.currentFingerprint) return undefined;
    const current = registry.values();
    for (const [fieldKey, expected] of Object.entries(supply.values)) {
      if (!Object.prototype.hasOwnProperty.call(current, fieldKey)) continue;
      if (!equalFormValue(current[fieldKey], expected)) return undefined;
    }
    return supply.feedback;
  }, [registry, supply]);

  const draftFeedbackFor = useCallback(
    (fieldKey: string): FormFieldDraftFeedback | undefined => {
      const feedback = applicableFeedback();
      if (feedback === undefined) return undefined;
      const state = feedback.fields.find((field) => field.fieldKey === fieldKey);
      if (state !== undefined && !state.visible) return undefined;
      const messages: FormDraftFeedbackMessage[] = [];
      for (const requirement of feedback.requirements)
        if (requirement.fieldKey === fieldKey)
          messages.push({ severity: "error", text: requirement.message });
      const refusal = feedback.refusal;
      if (refusal !== undefined && refusal.fieldKey === fieldKey)
        messages.push({ severity: "error", text: refusal.message });
      if (state === undefined && messages.length === 0) return undefined;
      return { required: state?.required ?? false, disabled: state?.disabled ?? false, messages };
    },
    [applicableFeedback],
  );

  const draftFeedbackSummary = useCallback((): FormDraftFeedbackSummary | undefined => {
    const feedback = applicableFeedback();
    if (feedback === undefined) return undefined;
    const messages: FormDraftFeedbackMessage[] = feedback.warnings.map((text) => ({
      severity: "warning" as const,
      text,
    }));
    const refusal = feedback.refusal;
    if (
      refusal !== undefined &&
      (refusal.fieldKey === undefined ||
        !feedback.fields.some((field) => field.fieldKey === refusal.fieldKey))
    )
      messages.push({ severity: "error", text: refusal.message });
    return messages.length === 0 ? undefined : { messages };
  }, [applicableFeedback]);

  const scope: FormScope = useMemo(
    () => ({
      pending: context.pending,
      inactive: context.inactive,
      register: registry.register,
      draftFeedbackFor,
      draftFeedbackSummary,
      reportFieldChanged,
    }),
    [
      context.pending,
      context.inactive,
      registry,
      draftFeedbackFor,
      draftFeedbackSummary,
      reportFieldChanged,
    ],
  );

  const events = context.events;
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  const readyRef = useRef(false);
  useEffect(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    eventsRef.current?.form_ready?.({ event: "form_ready" });
  }, []);

  const resetRef = useRef(false);
  useEffect(() => {
    if (!resetRef.current) return;
    resetRef.current = false;
    formRef.current?.querySelector<HTMLElement>(FIRST_FIELD_SELECTOR)?.focus();
  }, [generation]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (context.inactive) return;
    events?.form_submit?.({ event: "form_submit", values: registry.values() });
  };

  // Enter in a single-line field always uses the one submit path, with or without a Submit button.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    const target = event.target;
    if (
      event.key !== "Enter" ||
      event.nativeEvent.isComposing ||
      !(target instanceof HTMLInputElement) ||
      NON_SUBMITTING_INPUT_TYPES.has(target.type)
    )
      return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  const onReset = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (context.inactive) return;
    resetRef.current = true;
    setGeneration((current) => current + 1);
    events?.form_reset?.({ event: "form_reset" });
  };

  const title = context.accessibleName;
  const fieldsDisabled = context.unavailable || props.controlData?.status === "disabled";
  const note = context.unavailable ? "Unavailable" : context.disabledReason;
  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={onSubmit}
      onReset={onReset}
      onKeyDown={onKeyDown}
      aria-busy={context.pending}
      {...(title === undefined ? {} : { "aria-labelledby": titleId })}
      data-vortex-control="form-container"
      data-vortex-placement-id={props.placementId}
      className="vortex-form"
    >
      {title === undefined ? null : (
        <h2 id={titleId} className="vortex-form-title">
          {title}
        </h2>
      )}
      {note === undefined ? null : <p className="vortex-field-note">{note}</p>}
      <FormScopeContext.Provider value={scope}>
        <fieldset
          key={generation}
          disabled={fieldsDisabled}
          className="vortex-form-fields"
        >
          {props.slots.content ?? null}
        </fieldset>
      </FormScopeContext.Provider>
      <FormDraftFeedbackRegion id={feedbackId} summary={draftFeedbackSummary()} />
    </form>
  );
}
