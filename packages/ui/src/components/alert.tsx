import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/*
 * One severity treatment per variant: a left rule and title in the severity's semantic text role
 * (success, warning, info, destructive) on the resolved theme's surface; never a chart colour.
 * Tailwind only emits utilities it finds as complete strings in source, so each variant spells its
 * own classes out.
 */
const infoVariant =
  "border-l-4 bg-background border-l-info " +
  "[&_[data-slot=alert-title]]:font-bold [&_[data-slot=alert-title]]:text-info " +
  "[&_[data-slot=alert-description]]:text-foreground";
const successVariant =
  "border-l-4 bg-background border-l-success " +
  "[&_[data-slot=alert-title]]:font-bold [&_[data-slot=alert-title]]:text-success " +
  "[&_[data-slot=alert-description]]:text-foreground";
const warningVariant =
  "border-l-4 bg-background border-l-warning " +
  "[&_[data-slot=alert-title]]:font-bold [&_[data-slot=alert-title]]:text-warning " +
  "[&_[data-slot=alert-description]]:text-foreground";
const dangerVariant =
  "border-l-4 bg-background border-l-destructive " +
  "[&_[data-slot=alert-title]]:font-bold [&_[data-slot=alert-title]]:text-destructive " +
  "[&_[data-slot=alert-description]]:text-foreground";

const alertVariants = cva(
  "cn-alert group/alert relative w-full",
  {
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
  },
);

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
        "cn-alert-title [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
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
        "cn-alert-description [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="alert-action" className={cn("cn-alert-action", className)} {...props} />
  );
}

export { Alert, alertVariants, AlertTitle, AlertDescription, AlertAction };
