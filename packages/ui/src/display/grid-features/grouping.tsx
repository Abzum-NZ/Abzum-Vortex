"use client";

import { Button } from "../../components/button";
import type { GridFeatureModule, GridFeaturePointProps } from "./registry";

function Grouping({ context }: GridFeaturePointProps) {
  const grouping = context.features.grouping;
  if (grouping === undefined) return null;
  const change = (kind: "group" | "groups", key: string | undefined) => void context.events?.group_changed?.({ event: "group_changed", kind, key });
  return (
    <div className="flex w-full flex-col gap-2" aria-label={`Group by ${grouping.label}`}>
      <p className="m-0 text-sm font-medium">{grouping.label}</p>
      <div className="flex flex-wrap gap-1">
        {grouping.groups.map((group) => (
          <Button key={group.key} size="sm" variant={grouping.active === group.key ? "secondary" : "ghost"}
            aria-pressed={grouping.active === group.key}
            onClick={() => change("group", grouping.active === group.key ? undefined : group.key)}>
            {group.label}<span className="text-muted-foreground tabular-nums">{group.count}</span>
          </Button>
        ))}
      </div>
      {grouping.after === null && grouping.next === null ? null : (
        <div className="flex gap-1">
          {grouping.after === null ? null : <Button size="sm" variant="ghost" onClick={() => change("groups", undefined)}>First groups</Button>}
          {grouping.next === null ? null : <Button size="sm" variant="outline" onClick={() => change("groups", grouping.next!)}>Next groups</Button>}
        </div>
      )}
    </div>
  );
}

export const gridFeature: GridFeatureModule = { ToolbarItems: Grouping };
