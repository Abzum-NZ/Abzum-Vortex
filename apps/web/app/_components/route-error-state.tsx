"use client";

import { useEffect } from "react";
import { reportRouteFailure } from "../_lib/route-failure-report";
import { UnavailableState } from "./unavailable-state";

/**
 * The one error state for a route segment: it never shows the failure's own message (in production
 * that is React's minified text), only the digest Next.js assigned, reports the failure to the
 * server log, and offers a retry that draws the segment again.
 */
export function RouteErrorState({
  route,
  error,
  reset,
  region = "page",
}: Readonly<{
  route: string;
  error: Error & { digest?: string };
  reset: () => void;
  /** An application page's error shows in the frame's content region, not as a whole page. */
  region?: "page" | "content";
}>) {
  useEffect(() => {
    void reportRouteFailure(route, error.digest);
  }, [route, error.digest]);

  return (
    <UnavailableState
      title="This page could not be shown"
      sentence="Try again; if it keeps failing, your administrator can see the cause in the server log."
      reference={error.digest}
      way={{ kind: "retry", reset }}
      region={region}
    />
  );
}
