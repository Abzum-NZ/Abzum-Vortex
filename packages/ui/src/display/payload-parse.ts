import { isRecord } from "@vortex/platform/schema";
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

const requireString = (
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
