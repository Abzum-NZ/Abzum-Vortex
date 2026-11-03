"use client";
import { cloneElement, useId, type ComponentProps, type ReactElement, type ReactNode } from "react";
import {
  definitionLimitMessage,
  definitionLimitReached,
  definitionLimitNear,
  definitionLimitUsage,
  type CountedLimit,
} from "@vortex/platform/schema";
import { FieldDescription } from "../components/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";

/** The reason a control is unavailable at its limit, or nothing while the limit is not reached. */
export const studioLimitReason = (limit: CountedLimit, used: number): string | undefined =>
  definitionLimitReached(limit, used) ? definitionLimitMessage(limit) : undefined;

/** What a reasoned control may set on its tooltip. */
export type ReasonedTooltipProps = Pick<
  ComponentProps<typeof TooltipContent>,
  "style" | "collisionBoundary" | "collisionPadding"
>;

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
  describedBy,
  contentProps,
  children,
}: Readonly<{
  reason: string | undefined;
  /** The id of an element on the page that already says the reason (one Alert for many controls). */
  describedBy?: string | undefined;
  /** How the tooltip is drawn where the control is shown scaled or clipped (the canvas's action bar). */
  contentProps?: ReasonedTooltipProps | undefined;
  children: ReactElement<ReasonedProps>;
}>) {
  const id = useId();
  if (reason === undefined) return children;
  const { children: inner } = children.props as { children?: ReactNode };
  const swallowed = cloneElement(children, {
    "aria-disabled": true,
    "aria-describedby": [children.props["aria-describedby"], describedBy ?? id]
      .filter((entry) => entry !== undefined)
      .join(" "),
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
        <TooltipContent {...contentProps}>{reason}</TooltipContent>
      </Tooltip>
      {describedBy === undefined ? (
        <span id={id} className="sr-only">
          {reason}
        </span>
      ) : null}
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
    </FieldDescription>
  );
}
