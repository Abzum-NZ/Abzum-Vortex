"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { Icon } from "../icons/icon";
import { Button } from "./button";
import { cn } from "../lib/utils";
import { useVortexStylePortalRoot } from "../theme/vortex-style-root";

const Combobox = ComboboxPrimitive.Root;

function ComboboxInputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn("cn-input-group group/input-group relative flex w-full min-w-0 items-center", className)}
      {...props}
    />
  );
}

function ComboboxInputAddon({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group-addon"
      data-align="inline-end"
      role="group"
      className={cn(
        "cn-input-group-addon cn-input-group-addon-align-inline-end flex items-center",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="input-group-control"
      className={cn(
        "cn-input cn-input-group-input min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxTrigger({ className, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      render={<Button type="button" variant="ghost" size="icon-xs" />}
      className={cn("cn-combobox-trigger cn-input-group-button cn-input-group-button-size-icon-xs", className)}
      {...props}
    >
      <Icon name="chevron-down" className="cn-combobox-trigger-icon" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<Button type="button" variant="ghost" size="icon-xs" />}
      className={cn("cn-combobox-clear cn-input-group-button cn-input-group-button-size-icon-xs", className)}
      {...props}
    >
      <Icon name="close" className="cn-combobox-clear-icon" />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxPortal({ container, ...props }: ComboboxPrimitive.Portal.Props) {
  const styleRoot = useVortexStylePortalRoot();
  if (styleRoot !== null && styleRoot.element === null && container === undefined) return null;
  return (
    <ComboboxPrimitive.Portal
      container={container ?? styleRoot?.element ?? undefined}
      {...props}
    />
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
      <ComboboxPrimitive.ItemIndicator
        render={<span className="cn-combobox-item-indicator" />}
      >
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
  ComboboxInputAddon,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxPortal,
  ComboboxTrigger,
};
