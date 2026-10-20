"use client";

import { useEffect } from "react";
import { fillPreviewAfterRead } from "../_lib/studio-preview-reader";

/** Mounting confirms the runtime page answered; leaving it releases its share of the idle lease. */
export function RuntimePreviewIdleFill({
  organizationId,
  rootId,
  draftRevision,
  previewInstallationId,
}: Readonly<{
  organizationId: string;
  rootId: string;
  draftRevision: number;
  previewInstallationId: string;
}>) {
  useEffect(() => {
    const controller = new AbortController();
    fillPreviewAfterRead(
      organizationId,
      { rootId, draftRevision },
      previewInstallationId,
      controller.signal,
    );
    return () => controller.abort();
  }, [organizationId, rootId, draftRevision, previewInstallationId]);
  return null;
}
