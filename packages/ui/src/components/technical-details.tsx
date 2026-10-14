"use client";

import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

/** Collapsed section that keeps identifiers, revisions and raw source out of the builder's way. */
function TechnicalDetails({ title = "Technical details", className, children }: {
  title?: string; className?: string; children: ReactNode;
}) {
  return (
    <Collapsible className={cn("rounded-lg border bg-muted/30 text-sm", className)}>
      <CollapsibleTrigger className="w-full px-3 py-2 text-left font-medium underline-offset-2 hover:underline">
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Raw JSON behind a collapsed "View source" section. */
function ViewSource({ value, title = "View source" }: { value: unknown; title?: string }) {
  return (
    <TechnicalDetails title={title}>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(value, null, 2)}</pre>
    </TechnicalDetails>
  );
}

export { TechnicalDetails, ViewSource };
