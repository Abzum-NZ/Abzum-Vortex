"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";
import { useVortexStylePortalRoot } from "../theme/vortex-style-root";

const Select = SelectPrimitive.Root;

function SelectPortal({ container, ...props }: SelectPrimitive.Portal.Props) {
  const styleRoot = useVortexStylePortalRoot();
  const [anchor, setAnchor] = React.useState<HTMLSpanElement | null>(null);
  if (styleRoot !== null && styleRoot.element === null && container === undefined) return null;
  const needsAnchor = styleRoot === null && container === undefined;
  const containingRoot = needsAnchor ? anchor?.closest("[data-vortex-style-root]") : null;
  return (
    <>
      {needsAnchor && <span ref={setAnchor} hidden aria-hidden="true" />}
      {(!needsAnchor || anchor !== null) && (
        <SelectPrimitive.Portal
          container={
            container ??
            styleRoot?.element ??
            (containingRoot instanceof HTMLElement ? containingRoot : undefined)
          }
          {...props}
        />
      )}
    </>
  );
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("cn-select-group", className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("cn-select-value line-clamp-1", className)}
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & { size?: "sm" | "default" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "cn-select-trigger inline-flex w-full items-center justify-between whitespace-nowrap outline-none select-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<Icon name="chevron-down" className="cn-select-trigger-icon" />}
      />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = false,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPortal>
      <SelectPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            "cn-select-content cn-select-content-aria cn-select-content-logical cn-menu-target cn-menu-translucent relative w-(--anchor-width) max-h-(--available-height) overflow-y-auto",
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List data-slot="select-list">
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPortal>
  );
}

function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("cn-select-label", className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "cn-select-item cn-select-item-aria relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="cn-select-item-text">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={<span className="cn-select-item-indicator" />}
      >
        <Icon name="check" className="cn-select-item-indicator-icon" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("cn-select-separator", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn("cn-select-scroll-up-button", className)}
      {...props}
    >
      <Icon name="chevron-up" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn("cn-select-scroll-down-button", className)}
      {...props}
    >
      <Icon name="chevron-down" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectPortal,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
