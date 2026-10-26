"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@vortex/ui/components/sonner";

/**
 * Says once why joining from an invitation did not happen, then drops the outcome from the
 * address so a reload does not say it again.
 */
export function JoinOutcomeNotice({ sentence }: Readonly<{ sentence: string }>): null {
  const router = useRouter();
  useEffect(() => {
    toast.error(sentence);
    router.replace("/signed-in");
  }, [router, sentence]);
  return null;
}
