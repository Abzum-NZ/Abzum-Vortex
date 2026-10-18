"use client";
import type { ReactNode } from "react";
import { Icon } from "@vortex/ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vortex/ui/components/collapsible";

/** A field inspector's disclosure, with the same spacing and keyboard control in every group. */
export function StudioDataGroup({
  title,
  children,
  defaultOpen = true,
}: Readonly<{
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}>) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="space-y-4">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        <Icon
          name="chevron-right"
          className="size-4 transition-transform group-data-panel-open:rotate-90"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
