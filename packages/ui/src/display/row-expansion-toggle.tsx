"use client";

import type { ReactElement } from "react";
import { Button } from "../components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";

/**
 * The toggle that expands a row to its related records and collapses it again. It says which row
 * it opens and which panel it controls; the chevron turns when the row is open.
 */
export function RowExpansionToggle({
  name,
  expanded,
  panelId,
  onToggle,
}: Readonly<{
  name: string;
  expanded: boolean;
  panelId: string;
  onToggle: () => void;
}>): ReactElement {
  const label = `${expanded ? "Hide" : "Show"} related records of ${name}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            // The panel exists only while the row is open, so only then does the toggle name it.
            {...(expanded ? { "aria-controls": panelId } : {})}
            aria-label={label}
            onClick={onToggle}
            onKeyDown={(event) => {
              if (
                (event.key === "ArrowRight" && !expanded) ||
                (event.key === "ArrowLeft" && expanded)
              ) {
                event.preventDefault();
                onToggle();
              }
            }}
          />
        }
      >
        <Icon
          name="chevron-right"
          aria-hidden="true"
          className={cn(
            "transition-transform motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{expanded ? "Hide related records" : "Show related records"}</TooltipContent>
    </Tooltip>
  );
}
