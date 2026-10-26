"use client";

import * as React from "react";
import type { VortexStyle } from "./vortex-style";

/** The address of each style's own component stylesheet; a style without rules of its own has none. */
export type VortexStyleSheetHrefs = Readonly<Partial<Record<VortexStyle, string>>>;

const VortexStyleSheetsContext = React.createContext<VortexStyleSheetHrefs | null>(null);

/** Supplies the style stylesheet addresses the document serves to every style root below it. */
export function VortexStyleSheetsProvider({
  hrefs,
  children,
}: Readonly<{ hrefs: VortexStyleSheetHrefs; children: React.ReactNode }>) {
  return (
    <VortexStyleSheetsContext.Provider value={hrefs}>{children}</VortexStyleSheetsContext.Provider>
  );
}

/**
 * Loads one style's own component rules where a root paints with it. Each style's rules are a
 * cached stylesheet of their own, so the document carries only the styles on screen and its
 * elements are never matched against the rules of the styles it does not use. React puts the link
 * in the document head once and holds a client render that needs it until it has loaded.
 */
export function VortexStyleSheet({ style }: Readonly<{ style: VortexStyle }>) {
  const hrefs = React.useContext(VortexStyleSheetsContext);
  if (hrefs === null) throw new Error("A style root rendered outside VortexStyleSheetsProvider");
  const href = hrefs[style];
  return href === undefined ? null : <link rel="stylesheet" href={href} precedence="style" />;
}
