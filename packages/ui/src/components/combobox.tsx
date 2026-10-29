"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { Icon } from "../icons/icon";
import { InputGroupButton, InputGroupInput } from "./input-group";
import { cn } from "../lib/utils";
import { useVortexStylePortalRoot } from "../theme/vortex-style-root";

const Combobox = ComboboxPrimitive.Root;

/** The combobox's text input, drawn as the shadcn input group's control. */
function ComboboxInput(props: ComboboxPrimitive.Input.Props) {
  return <ComboboxPrimitive.Input render={<InputGroupInput />} {...props} />;
}

function ComboboxTrigger({ className, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      render={<InputGroupButton size="icon-xs" variant="ghost" />}
      className={cn("cn-combobox-trigger", className)}
      {...props}
    >
      <Icon name="chevron-down" className="cn-combobox-trigger-icon pointer-events-none" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroupButton variant="ghost" size="icon-xs" />}
      className={cn("cn-combobox-clear", className)}
      {...props}
    >
      <Icon name="close" className="cn-combobox-clear-icon pointer-events-none" />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxPortal({ container, ...props }: ComboboxPrimitive.Portal.Props) {
  const styleRoot = useVortexStylePortalRoot();
  if (styleRoot !== null && styleRoot.element === null && container === undefined) return null;
  return (
    <ComboboxPrimitive.Portal container={container ?? styleRoot?.element ?? undefined} {...props} />
  );
}

function ComboboxContent({
  className,
  children,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  return (
    <ComboboxPortal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          data-chips={!!anchor}
          className={cn(
            "cn-combobox-content cn-combobox-content-aria cn-combobox-content-logical cn-menu-target cn-menu-translucent group/combobox-content relative w-(--anchor-width) max-w-(--available-width)",
            className,
          )}
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPortal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("cn-combobox-list overscroll-contain", className)}
      {...props}
    />
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "cn-combobox-item cn-combobox-item-aria relative flex w-full cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="cn-combobox-item-text">{children}</span>
      <ComboboxPrimitive.ItemIndicator render={<span className="cn-combobox-item-indicator" />}>
        <Icon name="check" className="cn-combobox-item-indicator-icon" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("cn-combobox-empty", className)}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPortal,
  ComboboxTrigger,
};
