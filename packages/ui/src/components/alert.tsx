import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/*
 * One severity treatment per variant: the style's alert surface, with the severity's semantic
 * text role on the title and the style's left rule. Tailwind only emits utilities it finds as
 * complete strings in source, so each variant spells its own classes out.
 */
const infoVariant = "cn-alert-variant-default text-info after:bg-info";
const successVariant = "cn-alert-variant-default text-success after:bg-success";
const warningVariant = "cn-alert-variant-default text-warning after:bg-warning";
const dangerVariant = "cn-alert-variant-destructive text-destructive after:bg-destructive";

const alertVariants = cva("cn-alert group/alert relative w-full", {
  variants: {
    variant: {
      default: "cn-alert-variant-default",
      destructive: "cn-alert-variant-destructive",
      info: infoVariant,
      success: successVariant,
      warning: warningVariant,
      critical: `cn-alert-variant-destructive ${dangerVariant}`,
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "cn-alert-title group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "cn-alert-description md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-action" className={cn("cn-alert-action", className)} {...props} />;
}

export { Alert, alertVariants, AlertTitle, AlertDescription, AlertAction };
