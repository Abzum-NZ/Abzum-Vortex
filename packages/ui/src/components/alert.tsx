import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/** One severity treatment: a left rule, title and surface read from the resolved theme roles. */
const severityVariant = (textRole: string): string =>
  `border-l-4 bg-[var(--vortex-surface)] border-l-[var(${textRole})] ` +
  `[&_[data-slot=alert-title]]:font-bold [&_[data-slot=alert-title]]:text-[var(${textRole})] ` +
  "[&_[data-slot=alert-description]]:text-[var(--vortex-text)]";

const alertVariants = cva(
  "cn-alert group/alert relative w-full",
  {
    variants: {
      variant: {
        default: "cn-alert-variant-default",
        destructive: "cn-alert-variant-destructive",
        info: severityVariant("--vortex-info-text"),
        // The theme vocabulary has no separate success text role; success reads the info role.
        success: severityVariant("--vortex-info-text"),
        warning: severityVariant("--vortex-warning-text"),
        critical: `cn-alert-variant-destructive ${severityVariant("--vortex-danger-text")}`,
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
