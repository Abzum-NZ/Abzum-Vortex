"use client";
import {
  definitionLimitMessage,
  definitionLimitReached,
  definitionLimitNear,
  definitionLimitUsage,
  type CountedLimit,
} from "@vortex/platform/schema";
import { FieldDescription } from "../components/field";

/** The reason a control is unavailable at its limit, or nothing while the limit is not reached. */
export const studioLimitReason = (limit: CountedLimit, used: number): string | undefined =>
  definitionLimitReached(limit, used) ? definitionLimitMessage(limit) : undefined;

export { Reasoned } from "../components/reasoned";

/**
 * The usage of a limit at its control, said only once the limit is near (a line under every
 * control, at 0 percent, is noise); the full numbers live in the Limits group of the inspector.
 */
export function StudioLimitNote({
  limit,
  used,
  label,
}: Readonly<{ limit: CountedLimit; used: number; label?: string }>) {
  if (!definitionLimitNear(limit, used)) return null;
  return (
    <FieldDescription>
      {label === undefined ? "" : `${label}: `}
      {definitionLimitUsage(limit, used)}
    </FieldDescription>
  );
}
