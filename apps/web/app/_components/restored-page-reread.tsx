"use client";

import { useRouter } from "next/navigation";
import { useRestoredPage } from "@vortex/ui/routing";

/**
 * For a page composed whole on the server for this person (the organisation chooser, the launcher,
 * Studio's home): when Back or Forward restores it, it is read again, since access may have changed.
 */
export function RestoredPageReread(): null {
  const router = useRouter();
  useRestoredPage(() => router.refresh());
  return null;
}
