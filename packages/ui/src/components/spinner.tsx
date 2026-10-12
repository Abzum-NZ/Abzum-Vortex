import { cn } from "../lib/utils";
import { Icon } from "../icons/icon";
import type { VortexIconProps } from "../icons/icon-names";

function Spinner({ className, ...props }: Omit<VortexIconProps, "name">) {
  return (
    <Icon
      name="loader"
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
