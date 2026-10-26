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
