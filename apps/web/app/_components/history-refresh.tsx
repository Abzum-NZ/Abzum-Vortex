"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** History may restore a page whose installed release or access has changed since it was read. */
export function HistoryRefresh() {
  const router = useRouter();
  useEffect(() => {
    // Let Next's history listener select the destination before refreshing it in a new task.
    const refresh = () => window.setTimeout(() => router.refresh(), 0);
    window.addEventListener("popstate", refresh);
    return () => window.removeEventListener("popstate", refresh);
  }, [router]);
  return null;
}
