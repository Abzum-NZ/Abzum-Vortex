"use client";

import { RouteErrorState } from "./_components/route-error-state";

export default function Error({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return <RouteErrorState route="app" error={error} reset={reset} />;
}
