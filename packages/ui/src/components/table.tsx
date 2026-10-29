"use client";

import * as React from "react";
import { cn } from "../lib/utils";

/**
 * The data table: a bordered surface that scrolls inside its own container, with a header
 * that stays visible while the rows scroll and a quiet hover state on every row.
 */
function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn(
        "cn-table-container max-h-[70vh] max-w-full border bg-card text-card-foreground",
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        className={cn("cn-table border-collapse border-spacing-0", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("cn-table-header sticky top-0 z-10 bg-muted/60 backdrop-blur-sm", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("cn-table-body", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("cn-table-footer", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("cn-table-row has-aria-expanded:bg-muted/50", className)}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "cn-table-head text-xs font-medium tracking-wide text-muted-foreground uppercase",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("cn-table-cell", className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("cn-table-caption", className)} {...props} />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
