"use client";
import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import {
  definitionLimitMessage,
  definitionLimitNear,
  definitionLimitReached,
  definitionLimitUsage,
  type CountedLimit,
} from "@vortex/platform/schema";
import { FieldDescription } from "../components/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";

/** The reason a control is unavailable at its limit, or nothing while the limit is not reached. */
export const studioLimitReason = (limit: CountedLimit, used: number): string | undefined =>
  definitionLimitReached(limit, used) ? definitionLimitMessage(limit) : undefined;

type ReasonedProps = Readonly<{
  "aria-disabled"?: true;
  "aria-describedby"?: string;
  "data-reasoned"?: "";
  onClick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
  onCheckedChange?: () => void;
}>;

/**
 * A control that cannot be used right now and says why. The control stays the real, focusable
 * control: it is `aria-disabled` (a disabled button gets no hover and no focus, so it could not show
 * its reason), it is described by the reason for assistive technology, the reason shows in a tooltip
 * on hover and focus, and the activation is swallowed. One component for every limit at a control.
 */
export function StudioReasoned({
  reason,
  children,
}: Readonly<{ reason: string | undefined; children: ReactElement<ReasonedProps> }>) {
  const id = useId();
  if (reason === undefined) return children;
  const { children: inner } = children.props as { children?: ReactNode };
  const swallowed = cloneElement(children, {
    "aria-disabled": true,
    "aria-describedby": id,
    "data-reasoned": "",
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    ...(children.props.onCheckedChange === undefined ? {} : { onCheckedChange: () => undefined }),
  });
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={swallowed}>{inner}</TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </>
  );
}

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
      {definitionLimitReached(limit, used) ? `. ${definitionLimitMessage(limit)}` : ""}
    </FieldDescription>
  );
}
