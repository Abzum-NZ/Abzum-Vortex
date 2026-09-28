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
import { resolveControlContext, type ControlRenderProps } from "./control-context";
import {
  applicableDraftFeedback,
  fieldDraftFeedback,
  formDraftFeedbackSummary,
  FormDraftFeedbackRegion,
  type FormDraftFeedbackSupply,
} from "./draft-feedback";
import {
  createFormFieldRegistry,
  equalFormValue,
  FormScopeContext,
  useFormScope,
  type FormScope,
} from "./form-context";
import { useUnsavedWorkRegistry } from "./unsaved-work";
import type { FormPayload } from "./projected-data";

/**
 * A form container accepts its own projected data and declared callbacks, plus one supplied #591
 * draft-feedback result. All three are ordinary runtime inputs: the form container's registration
 * validates them fail-closed, so the page projection supplies the feedback and the page renderer
 * never names it. The control never computes or reinterprets a rule itself.
 */
export type FormContainerProps = ControlRenderProps<FormPayload> &
  Readonly<{
    draftFeedback?: FormDraftFeedbackSupply;
    flowFeedback?: FormFlowFeedback;
  }>;

/** A safe, final result returned by the form's bound flow. */
export type FormFlowFeedback = Readonly<{
  tone: "success" | "problem";
  text: string;
}>;

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
  const context = resolveControlContext<FormPayload>(props, [
    "form_ready",
    "form_submit",
    "form_reset",
  ]);
  if (useFormScope() !== undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A form container cannot be placed inside another form container",
      context.location,
    );

  const titleId = useId();
  const feedbackId = useId();
  const formId = props.placementId;
  const formRef = useRef<HTMLFormElement>(null);
  const [generation, setGeneration] = useState(0);
  const [ownerGroupChoice, setOwnerGroupChoice] = useState<string | undefined>();
  const [ownerGroupError, setOwnerGroupError] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Readonly<Record<string, string>>>({});
  const [registry] = useState(() => createFormFieldRegistry(context.location));
  const unsavedWorkRegistry = useUnsavedWorkRegistry();
  const baselineRef = useRef<Readonly<Record<string, unknown>> | undefined>(undefined);
  const [, setFeedbackTick] = useState(0);
  const validationAttemptedRef = useRef(false);
  const supply = props.draftFeedback;
  const supplied = supply !== undefined;
  const resetBaseline = useCallback(() => {
    baselineRef.current = registry.values();
  }, [registry]);
  const setSavedBaseline = useCallback(
    (values: Readonly<Record<string, unknown>>): boolean => {
      baselineRef.current = values;
      return !equalFormValue(registry.values(), values);
    },
    [registry],
  );
  // Rechecks settled feedback only while a result is supplied; without one a
  // keystroke must not re-render the whole form.
  const reportFieldChanged = useCallback(() => {
    if (supplied) setFeedbackTick((current) => current + 1);
    if (validationAttemptedRef.current)
      setValidationErrors(registry.validationErrors());
    const baseline = baselineRef.current;
    if (baseline !== undefined)
      unsavedWorkRegistry?.setDirty(
        formId,
        !equalFormValue(registry.values(), baseline) || ownerGroupChoice !== undefined,
      );
  }, [formId, ownerGroupChoice, registry, supplied, unsavedWorkRegistry]);

  // Applicability is decided once per render from the fields' current typed
  // values, and the scope changes with it, so every field clears or restores
  // its feedback together when any field's value changes or a result arrives.
  const fieldValues = registry.values();
  const feedback = applicableDraftFeedback(supply, fieldValues);
  const summary = formDraftFeedbackSummary(feedback, new Set(Object.keys(fieldValues)));
  const draftFeedbackFor = useCallback(
    (fieldKey: string) => fieldDraftFeedback(feedback, fieldKey),
    [feedback],
  );
  const fieldErrorFor = useCallback(
    (fieldKey: string) => validationErrors[fieldKey],
    [validationErrors],
  );

  const scope: FormScope = useMemo(
    () => ({
      pending: context.pending,
      inactive: context.inactive,
      register: registry.register,
      values: registry.values,
      fieldErrorFor,
      draftFeedbackFor,
      reportFieldChanged,
    }),
    [context.pending, context.inactive, registry, fieldErrorFor, draftFeedbackFor, reportFieldChanged],
  );

  const events = context.events;
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  const readyRef = useRef(false);
  useEffect(() => {
    if (context.inactive || readyRef.current) return;
    readyRef.current = true;
    eventsRef.current?.form_ready?.({ event: "form_ready" });
  }, [context.inactive]);

  useEffect(() => {
    resetBaseline();
    return unsavedWorkRegistry?.registerForm(formId, resetBaseline, setSavedBaseline);
  }, [formId, generation, resetBaseline, setSavedBaseline, unsavedWorkRegistry]);

  const resetRef = useRef(false);
  useEffect(() => {
    if (!resetRef.current) return;
    resetRef.current = false;
    formRef.current?.querySelector<HTMLElement>(FIRST_FIELD_SELECTOR)?.focus();
  }, [generation]);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (context.inactive) return;
    validationAttemptedRef.current = true;
    const nextValidationErrors = registry.validationErrors();
    setValidationErrors(nextValidationErrors);
    if (Object.keys(nextValidationErrors).length > 0) return;
    if (ownerGroups !== undefined && selectedOwnerGroupId === undefined) {
      setOwnerGroupError(true);
      return;
    }
    events?.form_submit?.({
      event: "form_submit",
      values: registry.values(),
      ...(selectedOwnerGroupId === undefined ? {} : { selectedOwnerGroupId }),
    });
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
    baselineRef.current = undefined;
    unsavedWorkRegistry?.setDirty(formId, false);
    resetRef.current = true;
    setOwnerGroupChoice(undefined);
    setOwnerGroupError(false);
    validationAttemptedRef.current = false;
    setValidationErrors({});
    setGeneration((current) => current + 1);
    events?.form_reset?.({ event: "form_reset" });
  };

  const title = context.accessibleName;
  const ownerGroups = props.data?.status === "ready" ? props.data.values.ownerGroups : undefined;
  const selectedOwnerGroupId = ownerGroups?.length === 1
    ? ownerGroups[0]?.groupId
    : ownerGroups?.some((group) => group.groupId === ownerGroupChoice)
      ? ownerGroupChoice
      : undefined;
  const fieldsDisabled = context.unavailable || props.data?.status === "disabled" ||
    ownerGroups?.length === 0;
  const note = context.unavailable ? "Unavailable" : context.disabledReason;
  if (props.data?.status === "disabled" && props.data.reason === "Record unavailable")
    return (
      <p
        role="alert"
        data-vortex-control="form-container"
        data-vortex-placement-id={props.placementId}
      >
        Record unavailable.
      </p>
    );
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
      className="flex flex-col gap-4"
    >
      {title === undefined ? null : (
        <h2 id={titleId} className="font-heading text-base font-medium">
          {title}
        </h2>
      )}
      {note === undefined ? null : (
        <p data-vortex-field-note className="text-sm text-muted-foreground">
          {note}
        </p>
      )}
      {ownerGroups === undefined ? null : ownerGroups.length === 0 ? (
        <p role="alert" className="text-sm text-muted-foreground">
          You need current membership in an active Group before you can create this record.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {ownerGroups.length === 1 ? (
            <p className="text-sm">
              <span className="font-medium">Owner Group: </span>{ownerGroups[0]?.label}
            </p>
          ) : (
            <>
              <label htmlFor={`${feedbackId}-owner-group`} className="text-sm font-medium">
                Owner Group
              </label>
              <select
                id={`${feedbackId}-owner-group`}
                value={selectedOwnerGroupId ?? ""}
                onChange={(event) => {
                  const groupId = event.target.value || undefined;
                  setOwnerGroupChoice(groupId);
                  setOwnerGroupError(false);
                  const baseline = baselineRef.current;
                  if (baseline !== undefined)
                    unsavedWorkRegistry?.setDirty(
                      formId,
                      groupId !== undefined || !equalFormValue(registry.values(), baseline),
                    );
                }}
                disabled={fieldsDisabled}
                aria-invalid={ownerGroupError}
                className="rounded border px-2 py-1 text-sm"
              >
                <option value="">Select a Group</option>
                {ownerGroups.map((group) => (
                  <option key={group.groupId} value={group.groupId}>{group.label}</option>
                ))}
              </select>
            </>
          )}
          {ownerGroupError ? (
            <p role="alert" className="text-sm text-destructive">Select an owner Group.</p>
          ) : null}
        </div>
      )}
      <FormScopeContext.Provider value={scope}>
        <fieldset
          key={generation}
          disabled={fieldsDisabled}
          className="flex min-w-0 flex-col gap-4 border-0 p-0"
        >
          {props.slots.content ?? null}
        </fieldset>
      </FormScopeContext.Provider>
      <FormDraftFeedbackRegion id={feedbackId} summary={summary} />
      {props.flowFeedback === undefined ? null : (
        <p
          role={props.flowFeedback.tone === "problem" ? "alert" : "status"}
          aria-live="polite"
          data-vortex-form-feedback={props.flowFeedback.tone}
        >
          {props.flowFeedback.text}
        </p>
      )}
    </form>
  );
}
