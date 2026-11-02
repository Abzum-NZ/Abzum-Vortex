"use client";
import { Button } from "@vortex/ui/components/button";
import { definitionLimitUsage, type DefinitionLimit } from "@vortex/platform/schema";

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
          <Button type="button" variant="link" size="xs" onClick={action.onSelect}>
            {action.label}
          </Button>
        )}
      </span>
    </div>
  );
}
