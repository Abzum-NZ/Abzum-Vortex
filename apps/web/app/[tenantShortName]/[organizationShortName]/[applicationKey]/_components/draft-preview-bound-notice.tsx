"use client";

import { usePathname } from "next/navigation";
import { formatCount } from "@vortex/platform/schema";

/**
 * Says, on a page whose records reached the preview bound, that the preview holds only the
 * first records of that type the builder can see. The frame stays mounted while pages change,
 * so the current page is read from the address.
 */
export function DraftPreviewBoundNotice({
  seedBound,
  seedBoundedPages,
}: Readonly<{ seedBound: number; seedBoundedPages: Readonly<Record<string, string>> }>) {
  const pathname = usePathname();
  const pageKey = decodeURIComponent(pathname.split("/").filter(Boolean).at(3) ?? "");
  const label = seedBoundedPages[pageKey];
  if (label === undefined) return null;
  return (
    <p className="basis-full">
      Preview shows the first {formatCount(seedBound)} {label} you can see.
    </p>
  );
}
