"use client";

import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import type { VariantProps } from "class-variance-authority";
import { toggleVariants } from "./toggle";
import { cn } from "../lib/utils";

type Variants = VariantProps<typeof toggleVariants>;
const ToggleGroupContext = React.createContext<Variants & { spacing: number }>({
  variant: "default",
  size: "default",
  spacing: 0,
});

function ToggleGroup({
  className,
  variant = "default",
  size = "default",
  spacing = 0,
  orientation = "horizontal",
  style,
  ...props
}: ToggleGroupPrimitive.Props & Variants & { spacing?: number }) {
  return (
    <ToggleGroupContext.Provider value={{ variant, size, spacing }}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        data-variant={variant}
        data-size={size}
        data-spacing={spacing}
        data-orientation={orientation}
        orientation={orientation}
        style={{ ...style, ["--gap" as string]: spacing }}
        className={cn(
          "cn-toggle-group group/toggle-group flex w-fit items-center gap-[--spacing(var(--gap))] data-[orientation=vertical]:flex-col",
          className,
        )}
        {...props}
      />
    </ToggleGroupContext.Provider>
  );
}

function ToggleGroupItem({ className, variant, size, ...props }: TogglePrimitive.Props & Variants) {
  const context = React.useContext(ToggleGroupContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={variant ?? context.variant}
      data-size={size ?? context.size}
      data-spacing={context.spacing}
      className={cn(
        "cn-toggle-group-item",
        toggleVariants({ variant: variant ?? context.variant, size: size ?? context.size }),
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
