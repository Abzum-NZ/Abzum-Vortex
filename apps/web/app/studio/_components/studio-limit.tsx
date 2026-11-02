"use client";
import type { ReactNode } from "react";
import { Button } from "@vortex/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import {
  definitionLimitMessage,
  definitionLimitReached,
  definitionLimitUsage,
  type CountedLimit,
  type DefinitionLimit,
} from "@vortex/platform/schema";

/** The reason a control is disabled at its limit, or nothing while the limit is not reached. */
export const studioLimitReason = (limit: CountedLimit, used: number): string | undefined =>
  definitionLimitReached(limit, used) ? definitionLimitMessage(limit) : undefined;

/**
 * A control that is disabled at a platform limit: the reason shows on hover and on focus, because a
 * disabled control cannot show it itself.
 */
export function StudioLimitReason({
  reason,
  children,
}: Readonly<{ reason: string | undefined; children: ReactNode }>) {
  if (reason === undefined) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** One row of limit usage: what is counted, `N of M used`, and an optional follow-up action. */
export function StudioLimitRow({
  label,
  limit,
  used,
  action,
}: Readonly<{
  label: string;
  limit: DefinitionLimit;
  used: number;
  action?: Readonly<{ label: string; onSelect: () => void }>;
}>) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
        {definitionLimitUsage(limit, used)}
        {action === undefined ? null : (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={action.onSelect}
          >
            {action.label}
          </Button>
        )}
      </span>
    </div>
  );
}
