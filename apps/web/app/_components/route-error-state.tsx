"use client";

import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { reportRouteFailure } from "../_lib/route-failure-report";

/**
 * The one error state for a route segment: it shows the failure's reason (Next.js replaces the
 * message of a server failure with a generic one in production and supplies a digest), reports the
 * failure to the server log, and offers a retry that re-renders the segment.
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

  // The content region already sits inside the frame's main landmark.
  const Region = region === "page" ? "main" : "section";
  return (
    <Region
      className={
        region === "page"
          ? "mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-4 p-6"
          : "flex w-full max-w-xl flex-col gap-4"
      }
    >
      <Alert variant="critical" role="alert">
        <AlertTitle>This page could not be shown</AlertTitle>
        <AlertDescription>
          <p className="m-0">{error.message}</p>
          {error.digest === undefined ? null : (
            <p className="m-0 mt-2 text-xs">Reference: {error.digest}</p>
          )}
        </AlertDescription>
      </Alert>
      <div>
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </Region>
  );
}
