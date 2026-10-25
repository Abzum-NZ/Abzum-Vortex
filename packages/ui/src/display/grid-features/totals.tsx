"use client";

import type { GridFeatureModule } from "./registry";

/** The scope stays visible beside the controls that change the filtered set. */
function TotalsScope() {
  return <span className="text-xs text-muted-foreground">Totals: all matching records</span>;
}

export const gridFeature: GridFeatureModule = { ToolbarItems: TotalsScope };
