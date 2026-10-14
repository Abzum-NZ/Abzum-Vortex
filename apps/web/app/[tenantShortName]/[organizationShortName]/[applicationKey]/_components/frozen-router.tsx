"use client";

import { useContext, useState, type ReactNode } from "react";
import { usePagePresence } from "@vortex/ui";
// The App Router gives each segment's children their tree through this context. Holding it lets the
// leaving page keep showing itself while it animates out, instead of the next page's tree.
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

/**
 * Keeps the page content it wraps on its own route while it leaves. While present it follows the
 * router (refreshes and query changes reach it); once removed it keeps the last tree it showed.
 */
export function FrozenRouter({ children }: Readonly<{ children: ReactNode }>) {
  const context = useContext(LayoutRouterContext);
  const present = usePagePresence();
  const [frozen, setFrozen] = useState(context);
  if (present && frozen !== context) setFrozen(context);
  return (
    <LayoutRouterContext.Provider value={present ? context : frozen}>
      {children}
    </LayoutRouterContext.Provider>
  );
}
