"use client";

import { useTransition, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@vortex/ui/components/button";

/**
 * Loads the address shown again, its layouts included: a link to the same address would keep a
 * layout that drew the state, so the state would stay after the read answers again. An error
 * boundary passes its `reset`, which draws the segment again beside the refresh.
 */
export function TryAgainButton({ reset }: Readonly<{ reset?: () => void }>): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      aria-busy={pending}
      disabled={pending}
      onClick={() =>
        startTransition(() => {
          router.refresh();
          reset?.();
        })
      }
    >
      Try again
    </Button>
  );
}
