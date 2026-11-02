"use client";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Pagination, PaginationContent, PaginationItem } from "@vortex/ui/components/pagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";

/**
 * Newer and Older for a newest-first list read one keyset page at a time. A control with nothing
 * to go to is disabled, and each says where it goes in its tooltip.
 */
export function StudioPager({
  hasNewer,
  hasOlder,
  disabled,
  onNewer,
  onOlder,
  noun,
}: Readonly<{
  hasNewer: boolean;
  hasOlder: boolean;
  /** A page is being read. */
  disabled: boolean;
  onNewer: () => void;
  onOlder: () => void;
  /** What the pages hold, in the plural ("versions"). */
  noun: string;
}>) {
  if (!hasNewer && !hasOlder) return null;
  return (
    <Pagination aria-label={`${noun} pages`}>
      <PaginationContent className="gap-2">
        <PaginationItem>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Newer ${noun}`}
                  disabled={disabled || !hasNewer}
                  onClick={onNewer}
                />
              }
            >
              <Icon name="chevron-left" />
            </TooltipTrigger>
            <TooltipContent>Newer {noun}</TooltipContent>
          </Tooltip>
        </PaginationItem>
        <PaginationItem>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Older ${noun}`}
                  disabled={disabled || !hasOlder}
                  onClick={onOlder}
                />
              }
            >
              <Icon name="chevron-right" />
            </TooltipTrigger>
            <TooltipContent>Older {noun}</TooltipContent>
          </Tooltip>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
