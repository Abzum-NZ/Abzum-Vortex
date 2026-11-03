import { cn } from "../lib/utils";
import { Separator } from "./separator";

function ButtonGroup({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<"div"> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(
        "cn-button-group flex w-fit items-stretch *:focus-visible:relative *:focus-visible:z-10 data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupText({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="button-group-text"
      className={cn(
        "cn-button-group-text flex items-center gap-2 [&_svg]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn("cn-button-group-separator relative self-stretch", className)}
      {...props}
    />
  );
}

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText };
