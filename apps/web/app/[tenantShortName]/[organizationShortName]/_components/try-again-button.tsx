"use client";

import { useTransition, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@vortex/ui/components/button";

/**
 * Loads the address shown again, its layouts included: a link to the same address would keep a
 * layout that drew the state, so the state would stay after the read answers again.
 */
export function TryAgainButton(): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      aria-busy={pending}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      Try again
    </Button>
  );
}
