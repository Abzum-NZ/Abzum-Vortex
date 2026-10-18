"use client";

import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import type { VariantProps } from "class-variance-authority";
import { toggleVariants } from "./toggle";
import { cn } from "../lib/utils";

type Variants = VariantProps<typeof toggleVariants>;
const ToggleGroupContext = React.createContext<Variants>({ variant: "default", size: "default" });

function ToggleGroup({
  className,
  variant = "default",
  size = "default",
  orientation = "horizontal",
  ...props
}: ToggleGroupPrimitive.Props & Variants) {
  return (
    <ToggleGroupContext.Provider value={{ variant, size }}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        data-spacing="0"
        data-orientation={orientation}
        orientation={orientation}
        className={cn(
          "cn-toggle-group group/toggle-group flex w-fit items-center data-[orientation=vertical]:flex-col",
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
      data-spacing="0"
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
