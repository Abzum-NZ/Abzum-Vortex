"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import type { FlowFieldCorrection, FlowRefusalFeedback } from "@vortex/platform/schema";
import { DefinitionRenderError } from "../definition-error";
import { FlowSurfaceContext } from "../flow-runtime/flow-surface-context";
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
import { usePendingGesture } from "./pending-gesture";
import type { FormPayload } from "./projected-data";
import { Alert, AlertDescription } from "../components/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/card";
import { Field, FieldError, FieldLabel } from "../components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";

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
export type FormFlowFeedback =
  | Readonly<{ kind: "message"; tone: "success" | "problem"; text: string }>
  | Readonly<{
      kind: "refusal";
      code: FlowRefusalFeedback["code"];
      fieldLabel?: string;
      corrections?: readonly FlowFieldCorrection[];
      /** The individually bounded authored messages of the rules that refused the change. */
      ruleMessages?: readonly string[];
      recovery?: "partial" | "uncertain";
    }>;

const fieldCorrectionText: Readonly<Record<FlowFieldCorrection["code"], string>> = {
  required_value: "This field is required.",
  invalid_value: "This value is not valid.",
  field_refused: "This value was not accepted.",
};

const refusalFeedbackText = (feedback: Extract<FormFlowFeedback, { kind: "refusal" }>): string => {
  if (feedback.ruleMessages !== undefined) return feedback.ruleMessages.join(" ");
  switch (feedback.code) {
    case "invalid_command":
      return feedback.fieldLabel === undefined
        ? "The supplied inputs are invalid."
        : `Check the ${feedback.fieldLabel} field and try again.`;
    case "duplicate_conflict":
      return "A conflicting item already exists.";
    case "stale_revision":
      return "This item changed. Refresh and try again.";
    case "recent_authentication_required":
      return "To protect your organisation, this change needs a sign-in within the last 15 minutes. Sign in again, then retry the change.";
    case "role_settings_change_required":
      return "Accepting application role changes keeps the role settings. Use Manage roles to change its name, description, classification or assignment and activation settings.";
    case "application_storage_incompatible":
      return "This version changes stored fields in a way existing records cannot accept. Keep existing choice options unchanged when adding options, and preserve field types, storage and ownership settings.";
    case "applications_manage_required":
      return "Installing or upgrading applications needs the Manage applications permission. An organisation steward can give you a role that has it in IAM.";
    case "installation_delegation_required":
      return "Installing this application needs app-installation authority over the permissions its roles grant. An organisation steward can grant it in IAM > People with Grant app-installation authority.";
    case "assignments_manage_required":
      return "Taking this application's role yourself needs the Manage access assignments permission. Install without taking the role, or ask an organisation steward for that permission in IAM.";
    default:
      return "The supplied inputs are invalid.";
  }
};

const refusalRecoveryText = {
  partial: "Only part of this was saved. Refresh and review what changed.",
  uncertain: "The result is not certain yet. Refresh before trying again.",
} as const;

const formFlowFeedbackPresentation = (
  feedback: FormFlowFeedback,
): Readonly<{ tone: "success" | "problem"; text: string }> =>
  feedback.kind === "message"
    ? { tone: feedback.tone, text: feedback.text }
    : {
        tone: "problem",
        text: `${refusalFeedbackText(feedback)}${
          feedback.recovery === undefined ? "" : ` ${refusalRecoveryText[feedback.recovery]}`
        }`,
      };

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
 * submits anywhere itself. Submission is refused while projected as pending or unavailable, and
 * while the flow its previous submission started is still running (the form shows busy).
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
  const inFlowSurface = useContext(FlowSurfaceContext);
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
  // Fields that depend on another field's value listen here; they re-render without the form.
  const listeners = useRef(new Set<() => void>());
  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  // The located corrections the person has edited past; a new submission shows them afresh.
  const [editedPastCorrections, setEditedPastCorrections] = useState<string | undefined>();
  // The submission's flow: the form is pending from the submit gesture until that flow settles.
  const submission = usePendingGesture();
  const pending = context.pending || submission.pending;
  useEffect(() => {
    if (pending) setEditedPastCorrections(undefined);
  }, [pending]);
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
  // The feedback is read through a ref: a callback that changed with each result would make every
  // field's mount effect report a change when the result arrives, marking its located corrections
  // as already edited past before the person has seen them.
  const flowFeedbackRef = useRef(props.flowFeedback);
  flowFeedbackRef.current = props.flowFeedback;
  const reportFieldChanged = useCallback(() => {
    for (const listener of [...listeners.current]) listener();
    const settled = flowFeedbackRef.current;
    if (settled?.kind === "refusal" && settled.corrections !== undefined)
      setEditedPastCorrections(JSON.stringify(settled.corrections));
    if (supplied) setFeedbackTick((current) => current + 1);
    if (validationAttemptedRef.current) setValidationErrors(registry.validationErrors());
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
    (fieldKey: string) => {
      if (Object.hasOwn(validationErrors, fieldKey)) return validationErrors[fieldKey];
      // A refusal from the server locates its corrections by the same field keys.
      const refused = props.flowFeedback;
      const correction =
        refused?.kind === "refusal" && JSON.stringify(refused.corrections) !== editedPastCorrections
          ? refused.corrections?.find((candidate) => candidate.field === fieldKey)
          : undefined;
      if (correction === undefined) return undefined;
      // A required value the server found missing is named by the field's own located message.
      return (
        correction.message ??
        (correction.code === "required_value"
          ? registry.validationErrors()[fieldKey]
          : undefined) ??
        fieldCorrectionText[correction.code]
      );
    },
    [validationErrors, props.flowFeedback, editedPastCorrections, registry],
  );

  const scope: FormScope = useMemo(
    () => ({
      pending,
      inactive: context.inactive,
      register: registry.register,
      values: registry.values,
      fieldErrorFor,
      draftFeedbackFor,
      reportFieldChanged,
      valueOf: registry.valueOf,
      subscribe,
    }),
    [
      pending,
      context.inactive,
      registry,
      fieldErrorFor,
      draftFeedbackFor,
      reportFieldChanged,
      subscribe,
    ],
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
    if (context.inactive || submission.running()) return;
    validationAttemptedRef.current = true;
    const nextValidationErrors = registry.validationErrors();
    setValidationErrors(nextValidationErrors);
    if (Object.keys(nextValidationErrors).length > 0) return;
    if (ownerGroups !== undefined && selectedOwnerGroupId === undefined) {
      setOwnerGroupError(true);
      return;
    }
    submission.track(
      events?.form_submit?.({
        event: "form_submit",
        values: registry.values(),
        ...(selectedOwnerGroupId === undefined ? {} : { selectedOwnerGroupId }),
      }),
    );
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
  const selectedOwnerGroupId =
    ownerGroups?.length === 1
      ? ownerGroups[0]?.groupId
      : ownerGroups?.some((group) => group.groupId === ownerGroupChoice)
        ? ownerGroupChoice
        : undefined;
  const fieldsDisabled =
    context.unavailable || props.data?.status === "disabled" || ownerGroups?.length === 0;
  // Why the form cannot be used now, such as a required field this person cannot fill in.
  const refusal = context.unavailable ? undefined : context.disabledReason;
  const flowFeedback =
    props.flowFeedback === undefined ? undefined : formFlowFeedbackPresentation(props.flowFeedback);
  const content = (
    <>
      {refusal === undefined ? null : (
        <Alert role="alert" className="mb-4" data-vortex-form-refusal="">
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      )}
      <form
        ref={formRef}
        noValidate
        onSubmit={onSubmit}
        onReset={onReset}
        onKeyDown={onKeyDown}
        aria-busy={pending}
        {...(inFlowSurface || title === undefined ? {} : { "aria-labelledby": titleId })}
        data-vortex-control="form-container"
        data-vortex-placement-id={props.placementId}
        className="flex flex-col gap-4"
      >
        {ownerGroups === undefined ? null : ownerGroups.length === 0 ? (
          <p role="alert" className="text-sm text-muted-foreground">
            You need current membership in an active Group before you can create this record.
          </p>
        ) : (
          <Field>
            {ownerGroups.length === 1 ? (
              <p className="text-sm">
                <span className="font-medium">Owner Group: </span>
                {ownerGroups[0]?.label}
              </p>
            ) : (
              <>
                <FieldLabel htmlFor={`${feedbackId}-owner-group`}>Owner Group</FieldLabel>
                <Select
                  items={[
                    { value: null, label: "Select a Group" },
                    ...ownerGroups.map((group) => ({ value: group.groupId, label: group.label })),
                  ]}
                  value={selectedOwnerGroupId ?? null}
                  disabled={fieldsDisabled}
                  onValueChange={(next) => {
                    const groupId = next ?? undefined;
                    setOwnerGroupChoice(groupId);
                    setOwnerGroupError(false);
                    const baseline = baselineRef.current;
                    if (baseline !== undefined)
                      unsavedWorkRegistry?.setDirty(
                        formId,
                        groupId !== undefined || !equalFormValue(registry.values(), baseline),
                      );
                  }}
                >
                  <SelectTrigger
                    id={`${feedbackId}-owner-group`}
                    aria-invalid={ownerGroupError}
                    className="w-full"
                  >
                    <SelectValue placeholder="Select a Group" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={null}>Select a Group</SelectItem>
                    {ownerGroups.map((group) => (
                      <SelectItem key={group.groupId} value={group.groupId}>
                        {group.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            {ownerGroupError ? <FieldError role="alert">Select an owner Group.</FieldError> : null}
          </Field>
        )}
        <FormScopeContext.Provider value={scope}>
          <fieldset
            key={generation}
            disabled={fieldsDisabled}
            className="vortex-form-content flex min-w-0 flex-col gap-4 border-0 p-0"
          >
            {props.slots.content ?? null}
          </fieldset>
        </FormScopeContext.Provider>
        <FormDraftFeedbackRegion id={feedbackId} summary={summary} />
        {flowFeedback === undefined ? null : (
          <Alert
            variant={flowFeedback.tone === "problem" ? "destructive" : "default"}
            role={flowFeedback.tone === "problem" ? "alert" : "status"}
            aria-live="polite"
            data-vortex-form-feedback={flowFeedback.tone}
          >
            <AlertDescription>{flowFeedback.text}</AlertDescription>
          </Alert>
        )}
      </form>
    </>
  );
  if (inFlowSurface)
    return (
      <>
        {context.unavailable ? (
          <p className="mb-4 text-sm text-muted-foreground" data-vortex-field-note="">
            Unavailable
          </p>
        ) : null}
        {content}
      </>
    );
  return (
    <Card>
      {title === undefined && !context.unavailable ? null : (
        <CardHeader>
          {title === undefined ? null : (
            <CardTitle id={titleId} role="heading" aria-level={2}>
              {title}
            </CardTitle>
          )}
          {context.unavailable ? (
            <CardDescription data-vortex-field-note="">Unavailable</CardDescription>
          ) : null}
        </CardHeader>
      )}
      <CardContent>{content}</CardContent>
    </Card>
  );
}
