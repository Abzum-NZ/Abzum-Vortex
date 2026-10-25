import { builderKeySchema, fieldIdSchema, isRecord } from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";

/*
 * The checks every projected payload parser shares. A payload the server built that fails one of
 * them is a defect: it throws a DefinitionRenderError naming the placement and property.
 */

export function fail(
  message: string,
  location: DefinitionRenderErrorLocation,
  propertyPath?: readonly string[],
): never {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    message,
    propertyPath === undefined ? location : { ...location, propertyPath },
  );
}

export const requireRecord = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Record<string, unknown> => (isRecord(value) ? value : fail(message, location));

export const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: DefinitionRenderErrorLocation,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`Unexpected projected display field '${key}'`, location);
  }
};

export const requireString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => (typeof value === "string" ? value : fail(message, location));

export const requireNonEmptyString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const text = requireString(value, message, location);
  return text.trim().length > 0 ? text : fail(message, location);
};

export const requireArray = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): readonly unknown[] => (Array.isArray(value) ? value : fail(message, location));

export const requireBuilderKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

/** A row cell, column, detail field or sort key: a builder key or a declared field identity. */
export const requireFieldKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = fieldIdSchema.safeParse(value);
  return field.success ? field.data : fail(message, location);
};

export const requirePositiveInteger = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : fail(message, location);

export const requireFiniteNumber = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(message, location);
