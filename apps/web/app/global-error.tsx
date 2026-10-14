"use client";

import "@vortex/ui/styles/globals.css";
import { RouteErrorState } from "./_components/route-error-state";

/**
 * Replaces the root layout when the layout itself fails, so it carries its own document. The
 * platform theme is read on the server and cannot be reached from this client boundary, so this
 * last-resort state renders with the stylesheet's own defaults.
 */
export default function GlobalError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <html lang="en">
      <body>
        <RouteErrorState route="app" error={error} reset={reset} />
      </body>
    </html>
  );
}
