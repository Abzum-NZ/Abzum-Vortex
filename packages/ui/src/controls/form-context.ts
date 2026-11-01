"use client";

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { FormFieldDraftFeedback } from "./draft-feedback";
import type { TypedFieldValue } from "./projected-data";
import type { FieldWriteCause } from "../flow-runtime/flow-cycle";
import { usePlacementReactions } from "../flow-runtime/placement-reactions";

/** One validated input change, published before its field-change event is dispatched. */
type FormFieldSet = Readonly<{
  value: TypedFieldValue;
  apply: () => void;
  emit: () => void;
}>;

/** Why a field takes no value now: the same answer for a flow's Set value and an agent's set_field. */
type FieldRefusal = "not_on_page" | "hidden" | "read_only" | "disabled" | "invalid_value";
export type FieldWriteResult =
  Readonly<{ kind: "set" }> | Readonly<{ kind: "refused"; reason: FieldRefusal }>;

/** One option a choice or link field offers its viewer now. */
export type FieldOption = Readonly<{ value: string; label: string }>;

/**
 * How a field takes a value from outside the person's keystrokes. `refusal` is the field's own
 * reason to take none now (hidden by its feedback, disabled or read-only); `set` checks and
 * prepares the value, or answers that it is not one the field accepts.
 */
export type FormFieldWriter = Readonly<{
  label: string;
  required: boolean;
  refusal: Exclude<FieldRefusal, "not_on_page" | "invalid_value"> | undefined;
  set: (value: unknown, cause: FieldWriteCause) => FormFieldSet | "invalid_value";
  /** The options the field offers, read the way the person's picker reads them. */
  options?: (search: string | undefined) => Promise<readonly FieldOption[]>;
}>;

/** What a form tells an agent about one of its fields. */
export type FormFieldDescription = Readonly<{
  key: string;
  /** The field's placement, whose change event an agent's set_field starts. */
  control: string;
  label: string;
  required: boolean;
  value: TypedFieldValue;
  /** Why the field takes no value now; absent when it takes one. */
  refusal?: Exclude<FieldRefusal, "not_on_page" | "invalid_value">;
  /** The field offers options to choose from. */
  hasOptions: boolean;
  /** The field's current problem, as the form shows it. */
  error?: string;
}>;

type FormField = Readonly<{
  placementId: string;
  read: () => TypedFieldValue;
  publish: (value: TypedFieldValue) => void;
  validate?: () => string | undefined;
  write: (value: unknown, cause: FieldWriteCause) => FieldWriteResult;
  describe: () => FormFieldDescription | undefined;
  options: (search: string | undefined) => Promise<readonly FieldOption[]> | undefined;
}>;

/** The enclosing form's field registry and activation state. */
export type FormScope = Readonly<{
  /** The form's placement. */
  formId: string;
  /** A submission is pending or the form's data is loading; submit cannot be activated. */
  pending: boolean;
  /** The form cannot be submitted or reset for any projected reason. */
  inactive: boolean;
  /** Registers one field's current typed value; returns its unregistration. */
  register: (fieldKey: string, field: FormField) => () => void;
  /** The current typed value of every registered field, by field key. */
  values: () => Readonly<Record<string, TypedFieldValue>>;
  /** The current local validation message for one field key, when a submit was refused. */
  fieldErrorFor: (fieldKey: string) => string | undefined;
  /** Located draft feedback for one field key, or nothing when none applies now. */
  draftFeedbackFor: (fieldKey: string) => FormFieldDraftFeedback | undefined;
  /** Reports that a field's value or registration changed, so settled feedback is rechecked. */
  reportFieldChanged: (fieldKey: string) => void;
  /** The current typed value of one registered field, or undefined while it is not registered. */
  valueOf: (fieldKey: string) => TypedFieldValue | undefined;
  /** Publishes a typed input value before its field-change event starts a flow. */
  publish: (fieldKey: string, value: TypedFieldValue) => void;
  /** Calls `listener` whenever any field's value or registration changes; returns its removal. */
  subscribe: (listener: () => void) => () => void;
  /** Submits the form through its one submit path, as its Submit button does. */
  submit: () => void;
  /** Registers an authored submit placement as a host for the form's actions. */
  registerSubmitActions: (element: HTMLElement) => () => void;
  /** Resets the form through its one reset path, as its Reset button does. */
  reset: () => void;
}>;

/**
 * Structural equality for a typed draft value. A field may rebuild an equal
 * record reference or rich-text document on every render, so a value is treated
 * as changed only when its content actually differs.
 */
export const equalFormValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => equalFormValue(entry, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] &&
      equalFormValue(
        (left as Readonly<Record<string, unknown>>)[key],
        (right as Readonly<Record<string, unknown>>)[key],
      ),
  );
};

export const FormScopeContext = createContext<FormScope | undefined>(undefined);

/** The nearest enclosing form container, if any. */
export const useFormScope = (): FormScope | undefined => useContext(FormScopeContext);

/**
 * Creates a field registry for one form. Two placements that claim the same field key in one
 * form are refused, so a submission never silently drops or overwrites a field's value.
 */
export function createFormFieldRegistry(location: DefinitionRenderErrorLocation): Readonly<{
  register: FormScope["register"];
  valueOf: FormScope["valueOf"];
  publish: FormScope["publish"];
  values: () => Readonly<Record<string, TypedFieldValue>>;
  write: (fieldKey: string, value: unknown, cause: FieldWriteCause) => FieldWriteResult;
  describe: () => readonly FormFieldDescription[];
  options: (
    fieldKey: string,
    search: string | undefined,
  ) => Promise<readonly FieldOption[]> | undefined;
  validationErrors: () => Readonly<Record<string, string>>;
}> {
  const fields = new Map<string, FormField>();
  return {
    register: (fieldKey, field) => {
      const existing = fields.get(fieldKey);
      if (existing !== undefined && existing.placementId !== field.placementId)
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Field key '${fieldKey}' is used by more than one placement in one form`,
          { ...location, childPlacementId: field.placementId },
        );
      fields.set(fieldKey, field);
      return () => {
        if (fields.get(fieldKey) === field) fields.delete(fieldKey);
      };
    },
    valueOf: (fieldKey) => fields.get(fieldKey)?.read(),
    publish: (fieldKey, value) => fields.get(fieldKey)?.publish(value),
    write: (fieldKey, value, cause) =>
      fields.get(fieldKey)?.write(value, cause) ?? { kind: "refused", reason: "not_on_page" },
    describe: () =>
      [...fields.values()].flatMap((field) => {
        const description = field.describe();
        return description === undefined ? [] : [description];
      }),
    options: (fieldKey, search) => fields.get(fieldKey)?.options(search),
    values: () =>
      Object.freeze(
        Object.fromEntries([...fields].map(([fieldKey, field]) => [fieldKey, field.read()])),
      ),
    validationErrors: () =>
      Object.freeze(
        Object.fromEntries(
          [...fields].flatMap(([fieldKey, field]) => {
            const message = field.validate?.();
            return message === undefined ? [] : [[fieldKey, message] as const];
          }),
        ),
      ),
  };
}

/**
 * Publishes one input's current typed value to its enclosing form, if any, and
 * reports a real value change so settled draft feedback is rechecked. The value
 * is written during render, so a form reading its registry in the same pass sees
 * the published value; a rebuilt but equal object is not a change.
 */
export function useFormField(
  fieldKey: string,
  placementId: string,
  value: TypedFieldValue,
  validate?: () => string | undefined,
  writer?: FormFieldWriter,
): void {
  const scope = useFormScope();
  const reactions = usePlacementReactions();
  const register = scope?.register;
  const reportFieldChanged = scope?.reportFieldChanged;
  const valueRef = useRef(value);
  const validateRef = useRef(validate);
  const writerRef = useRef(writer);
  const reactionsRef = useRef(reactions);
  reactionsRef.current = reactions;
  const previousRef = useRef(value);
  valueRef.current = value;
  validateRef.current = validate;
  writerRef.current = writer;
  useEffect(() => {
    if (equalFormValue(previousRef.current, value)) return;
    previousRef.current = value;
    reportFieldChanged?.(fieldKey);
  });
  // A field that mounts, remounts on reset or leaves also changes which values
  // settled feedback is compared with.
  useEffect(() => {
    const unregister = register?.(fieldKey, {
      placementId,
      read: () => valueRef.current,
      publish: (next) => {
        valueRef.current = next;
        reportFieldChanged?.(fieldKey);
      },
      validate: () => validateRef.current?.(),
      write: (next, cause) => {
        const current = writerRef.current;
        const refusal = reactionsRef.current.refusal?.() ?? current?.refusal;
        if (current === undefined || refusal !== undefined)
          return { kind: "refused", reason: refusal ?? "read_only" };
        const change = current.set(next, cause);
        if (change === "invalid_value") return { kind: "refused", reason: change };
        valueRef.current = change.value;
        change.apply();
        reportFieldChanged?.(fieldKey);
        change.emit();
        return { kind: "set" };
      },
      describe: () => {
        const current = writerRef.current;
        if (current === undefined) return undefined;
        const refusal = reactionsRef.current.refusal?.() ?? current.refusal;
        return {
          key: fieldKey,
          control: placementId,
          label: current.label,
          required: current.required,
          value: valueRef.current,
          ...(refusal === undefined ? {} : { refusal }),
          hasOptions: current.options !== undefined,
        };
      },
      options: (search) => writerRef.current?.options?.(search),
    });
    reportFieldChanged?.(fieldKey);
    return () => {
      unregister?.();
      reportFieldChanged?.(fieldKey);
    };
  }, [register, reportFieldChanged, fieldKey, placementId]);
}

/** Makes a typed keystroke visible to the form before its event starts a flow. */
export function useFormFieldPublisher(fieldKey: string): (value: TypedFieldValue) => void {
  const scope = useFormScope();
  return (value) => scope?.publish(fieldKey, value);
}

/** The local field-specific submit error, when the enclosing form has one. */
export const useFormFieldError = (fieldKey: string): string | undefined =>
  useFormScope()?.fieldErrorFor(fieldKey);

/**
 * Publishes one input's value like `useFormField`, and refuses a submit while a required value is
 * missing with the located "<label> is required." message. Returns the field's current submit error.
 * The caller decides when the value counts as missing, so a disabled or read-only input never blocks.
 */
export function useRequiredFormField(
  fieldKey: string,
  placementId: string,
  value: TypedFieldValue,
  requirement: Readonly<{ label: string; missing: boolean }>,
  writer?: FormFieldWriter,
): string | undefined {
  useFormField(
    fieldKey,
    placementId,
    value,
    requirement.missing ? () => `${requirement.label} is required.` : undefined,
    writer,
  );
  return useFormFieldError(fieldKey);
}

const neverChanges = (): (() => void) => () => undefined;

/**
 * The current value of another field of the enclosing form, so a field that depends on it can
 * offer only what fits and clear itself when it changes. Undefined without a form, without a named
 * field, or while that field is not registered (for example one the person may not read).
 */
export function useFormFieldValue(fieldKey: string | undefined): TypedFieldValue | undefined {
  const scope = useFormScope();
  return useSyncExternalStore(
    scope?.subscribe ?? neverChanges,
    () => (fieldKey === undefined ? undefined : scope?.valueOf(fieldKey)),
    () => undefined,
  );
}
