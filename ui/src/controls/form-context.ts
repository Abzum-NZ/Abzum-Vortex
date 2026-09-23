import { createContext, useContext, useEffect, useRef } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
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
}>;

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

/** Publishes one input's current typed value to its enclosing form, if any. */
export function useFormField(fieldKey: string, placementId: string, value: TypedFieldValue): void {
  const scope = useFormScope();
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(
    () => scope?.register(fieldKey, { placementId, read: () => valueRef.current }),
    [scope, fieldKey, placementId],
  );
}
