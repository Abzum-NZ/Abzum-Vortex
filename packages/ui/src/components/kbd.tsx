import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn("cn-kbd inline-flex items-center justify-center gap-1", className)}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd-group"
      className={cn("cn-kbd-group inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
