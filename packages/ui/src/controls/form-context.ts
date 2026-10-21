"use client";

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { FormFieldDraftFeedback } from "./draft-feedback";
import type { TypedFieldValue } from "./projected-data";

type FormField = Readonly<{
  placementId: string;
  read: () => TypedFieldValue;
  validate?: () => string | undefined;
}>;

/** The enclosing form's field registry and activation state. */
export type FormScope = Readonly<{
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
  /**
   * Reports that a field's value or registration changed, so settled feedback is rechecked; with
   * the field's key, the fields watching it are told too.
   */
  reportFieldChanged: (fieldKey?: string) => void;
  /**
   * Tells the fields watching `fieldKey` that the person edited it. A load, a reset and a mount
   * change a value without it, so a field that clears with another clears only on an edit.
   */
  reportFieldEdited: (fieldKey: string) => void;
  /** Calls `listener` when `fieldKey` changes value or is registered or removed, or when it is edited. */
  watch: (fieldKey: string, listener: (change: "changed" | "edited") => void) => () => void;
  /** The current typed value of one registered field, or undefined when no such field is on the form. */
  read: (fieldKey: string) => TypedFieldValue | undefined;
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
  values: () => Readonly<Record<string, TypedFieldValue>>;
  validationErrors: () => Readonly<Record<string, string>>;
  watch: FormScope["watch"];
  read: FormScope["read"];
  notify: (fieldKey: string, change: "changed" | "edited") => void;
}> {
  const fields = new Map<string, FormField>();
  const watchers = new Map<string, Set<(change: "changed" | "edited") => void>>();
  const notify = (fieldKey: string, change: "changed" | "edited"): void => {
    for (const listener of [...(watchers.get(fieldKey) ?? [])]) listener(change);
  };
  return {
    notify,
    watch: (fieldKey, listener) => {
      const listeners = watchers.get(fieldKey) ?? new Set();
      listeners.add(listener);
      watchers.set(fieldKey, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
    read: (fieldKey) => fields.get(fieldKey)?.read(),
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
): void {
  const scope = useFormScope();
  const register = scope?.register;
  const reportFieldChanged = scope?.reportFieldChanged;
  const valueRef = useRef(value);
  const validateRef = useRef(validate);
  const previousRef = useRef(value);
  valueRef.current = value;
  validateRef.current = validate;
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
      validate: () => validateRef.current?.(),
    });
    reportFieldChanged?.(fieldKey);
    return () => {
      unregister?.();
      reportFieldChanged?.(fieldKey);
    };
  }, [register, reportFieldChanged, fieldKey, placementId]);
}

/**
 * The current typed value of another field of the enclosing form, read again whenever that field
 * changes, and `onEdited` when the person edits it (never for a load or a reset). Undefined while
 * `fieldKey` is undefined, outside a form, or while no such field is on the form.
 */
export function useWatchedFormField(
  fieldKey: string | undefined,
  onEdited: () => void,
): TypedFieldValue | undefined {
  const scope = useFormScope();
  const onEditedRef = useRef(onEdited);
  onEditedRef.current = onEdited;
  const cache = useRef<TypedFieldValue | undefined>(undefined);
  const value = useSyncExternalStore(
    (listener) =>
      scope === undefined || fieldKey === undefined
        ? () => undefined
        : scope.watch(fieldKey, (change) => {
            if (change === "edited") onEditedRef.current();
            listener();
          }),
    () => {
      const current =
        scope === undefined || fieldKey === undefined ? undefined : scope.read(fieldKey);
      // A field may rebuild an equal record reference on every read; the snapshot must not change.
      if (!equalFormValue(cache.current, current)) cache.current = current;
      return cache.current;
    },
    () => undefined,
  );
  return value;
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
): string | undefined {
  useFormField(
    fieldKey,
    placementId,
    value,
    requirement.missing ? () => `${requirement.label} is required.` : undefined,
  );
  return useFormFieldError(fieldKey);
}
