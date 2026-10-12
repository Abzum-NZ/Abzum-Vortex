import * as React from "react";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";

/**
 * The shadcn native select: the browser's own `<select>` drawn with the form-control surface of
 * the Input. It keeps native keyboard, form and mobile behaviour, so it fits dense editors whose
 * options are a short closed list; the popup Select remains the control for rendered forms.
 */
function NativeSelect({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"select">, "size">) {
  return (
    <div
      data-slot="native-select-wrapper"
      className="relative w-fit has-[select:disabled]:opacity-50"
    >
      <select
        data-slot="native-select"
        className={cn(
          "h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-sm shadow-xs transition-colors outline-none select-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:pointer-events-none disabled:cursor-not-allowed dark:bg-input/30",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
      />
    </div>
  );
}

function NativeSelectOption({ ...props }: React.ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return <optgroup data-slot="native-select-optgroup" className={cn(className)} {...props} />;
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
