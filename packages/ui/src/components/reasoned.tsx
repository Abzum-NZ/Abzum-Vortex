"use client";
import { cloneElement, useId, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** What a reasoned control may set on its tooltip. */
export type ReasonedTooltipProps = Pick<
  ComponentProps<typeof TooltipContent>,
  "className" | "style" | "collisionBoundary" | "collisionPadding"
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
 * Given a `tip`, it is also the tooltip of the same control while it is available, so a control
 * that can become unavailable has one composition and one place in the tree in both states.
 */
export function Reasoned({
  reason,
  tip,
  describedBy,
  onRefused,
  contentProps,
  children,
}: Readonly<{
  reason: string | undefined;
  /**
   * What the tooltip says while the control is available. A control whose availability changes
   * under the person's hands (it goes busy when pressed) passes it, so the control keeps one place
   * in the tree and keeps the keyboard focus when it becomes unavailable.
   */
  tip?: ReactNode;
  /** An attempted use while unavailable; the caller shows the reason where it belongs. */
  onRefused?: (() => void) | undefined;
  /** The id of an element on the page that already says the reason (one Alert for many controls). */
  describedBy?: string | undefined;
  /** How the tooltip is drawn: its width for a long text, or where the control is scaled or clipped (the canvas's action bar). */
  contentProps?: ReasonedTooltipProps | undefined;
  children: ReactElement<ReasonedProps>;
}>) {
  const id = useId();
  const content = reason ?? tip;
  if (content === undefined) return children;
  const { children: inner } = children.props as { children?: ReactNode };
  const swallowed =
    reason === undefined
      ? children
      : cloneElement(children, {
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
          ...(children.props.onCheckedChange === undefined
            ? {}
            : { onCheckedChange: () => undefined }),
        });
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={swallowed}>{inner}</TooltipTrigger>
        <TooltipContent {...contentProps}>{content}</TooltipContent>
      </Tooltip>
      {reason !== undefined && describedBy === undefined ? (
        <span id={id} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  );
}
