"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { FormFieldDraftFeedback } from "./draft-feedback";
import type { TypedFieldValue } from "./projected-data";

type FormField = Readonly<{ placementId: string; read: () => TypedFieldValue }>;

/** The enclosing form's field registry and activation state. */
export type FormScope = Readonly<{
  /** A submission is pending or the form's data is loading; submit cannot be activated. */
  pending: boolean;
  /** The form cannot be submitted or reset for any projected reason. */
  inactive: boolean;
  /** Registers one field's current typed value; returns its unregistration. */
  register: (fieldKey: string, field: FormField) => () => void;
  /** Located draft feedback for one field key, or nothing when none applies now. */
  draftFeedbackFor: (fieldKey: string) => FormFieldDraftFeedback | undefined;
  /** Reports that a field's value or registration changed, so settled feedback is rechecked. */
  reportFieldChanged: () => void;
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
    values: () =>
      Object.freeze(
        Object.fromEntries([...fields].map(([fieldKey, field]) => [fieldKey, field.read()])),
      ),
  };
}

/**
 * Publishes one input's current typed value to its enclosing form, if any, and
 * reports a real value change so settled draft feedback is rechecked. The value
 * is written during render, so a form reading its registry in the same pass sees
 * the published value; a rebuilt but equal object is not a change.
 */
export function useFormField(fieldKey: string, placementId: string, value: TypedFieldValue): void {
  const scope = useFormScope();
  const register = scope?.register;
  const reportFieldChanged = scope?.reportFieldChanged;
  const valueRef = useRef(value);
  const previousRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (equalFormValue(previousRef.current, value)) return;
    previousRef.current = value;
    reportFieldChanged?.();
  });
  // A field that mounts, remounts on reset or leaves also changes which values
  // settled feedback is compared with.
  useEffect(() => {
    const unregister = register?.(fieldKey, { placementId, read: () => valueRef.current });
    reportFieldChanged?.();
    return () => {
      unregister?.();
      reportFieldChanged?.();
    };
  }, [register, reportFieldChanged, fieldKey, placementId]);
}
