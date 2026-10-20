"use client";

import { useEffect } from "react";
import { fillPreviewAfterRead } from "../_lib/studio-preview-reader";

/** Mounting confirms the runtime page answered; leaving it aborts its pending idle lease. */
export function RuntimePreviewIdleFill({
  organizationId,
  rootId,
  draftRevision,
}: Readonly<{ organizationId: string; rootId: string; draftRevision: number }>) {
  useEffect(() => {
    const controller = new AbortController();
    fillPreviewAfterRead(organizationId, { rootId, draftRevision }, controller.signal);
    return () => controller.abort();
  }, [organizationId, rootId, draftRevision]);
  return null;
}
