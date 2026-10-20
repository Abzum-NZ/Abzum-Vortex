"use client";

import type { ReactElement } from "react";

/** Sharing is assigned through the platform permission catalogue in Access. */
export function StudioSavedViewsEditor(): ReactElement {
  return (
    <p className="text-sm text-muted-foreground">
      Give roles the Share table views permission in Access to let people share views.
    </p>
  );
}
