import * as React from "react";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
};

/**
 * The shadcn native select: the browser's own `<select>` drawn with the form-control surface of
 * the active style. It keeps native keyboard, form and mobile behaviour, so it fits dense editors
 * whose options are a short closed list; the popup Select remains the control for rendered forms.
 */
function NativeSelect({ className, size = "default", ...props }: NativeSelectProps) {
  return (
    <div
      className={cn(
        "cn-native-select-wrapper group/native-select relative w-fit has-[select:disabled]:opacity-50",
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="cn-native-select outline-none disabled:pointer-events-none disabled:cursor-not-allowed"
        {...props}
      />
      <Icon
        name="chevron-down"
        className="cn-native-select-icon pointer-events-none absolute select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
