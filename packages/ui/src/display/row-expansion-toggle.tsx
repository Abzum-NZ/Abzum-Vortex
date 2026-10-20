"use client";

import type { ReactElement } from "react";
import { Button } from "../components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon } from "../icons/icon";
import { cn } from "../lib/utils";

/**
 * The toggle that expands a row to what it holds (its related records or the rows beneath it)
 * and collapses it again. It says which row it opens and which panel it controls; the chevron
 * turns when the row is open.
 */
export function RowExpansionToggle({
  name,
  noun,
  expanded,
  panelId,
  onToggle,
}: Readonly<{
  name: string;
  /** What the panel holds, in a sentence: "related records" or "child records". */
  noun: string;
  expanded: boolean;
  /** The panel the toggle controls; undefined when what it opens is rows of the grid itself. */
  panelId?: string;
  onToggle: () => void;
}>): ReactElement {
  const label = `${expanded ? "Hide" : "Show"} ${noun} of ${name}`;
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
            {...(expanded && panelId !== undefined ? { "aria-controls": panelId } : {})}
            aria-label={label}
            onClick={onToggle}
            onKeyDown={(event) => {
              if (
                (event.key === "ArrowRight" && !expanded) ||
                (event.key === "ArrowLeft" && expanded)
              ) {
                event.preventDefault();
                onToggle();
                return;
              }
              // F2 moves into the open panel, as it does from the toggle's cell.
              if (event.key === "F2" && expanded && panelId !== undefined) {
                const inner = document
                  .getElementById(panelId)
                  ?.querySelector<HTMLElement>(
                    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
                  );
                if (inner === null || inner === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                inner.focus();
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
      <TooltipContent>{expanded ? `Hide ${noun}` : `Show ${noun}`}</TooltipContent>
    </Tooltip>
  );
}
