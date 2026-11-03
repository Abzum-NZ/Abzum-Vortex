"use client";
import { cloneElement, useId, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

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
export function Reasoned({
  reason,
  describedBy,
  onRefused,
  contentProps,
  children,
}: Readonly<{
  reason: string | undefined;
  /** An attempted use while unavailable; the caller shows the reason where it belongs. */
  onRefused?: (() => void) | undefined;
  /** The id of an element on the page that already says the reason (one Alert for many controls). */
  describedBy?: string | undefined;
  /** How the tooltip is drawn where the control is scaled or clipped (the canvas's action bar). */
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
      onRefused?.();
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
