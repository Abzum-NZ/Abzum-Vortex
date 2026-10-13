"use client";

import { RouteErrorState } from "../../../_components/route-error-state";

export default function Error({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return <RouteErrorState route="application-address" error={error} reset={reset} />;
}
