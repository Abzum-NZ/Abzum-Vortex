"use client";

import type { BlockPropertyValueContract } from "@vortex/platform/schema";
import type { ReactElement } from "react";
import {
  ApplicationSearchControl,
  type ApplicationSearchRuntime,
} from "./application-search-control";
export type { ApplicationSearchRuntime } from "./application-search-control";

/** Puck's search block delegates to the shared search control. */
export function ApplicationSearchBlock(
  props: Readonly<{
    placementId: string;
    settings: Readonly<Record<string, BlockPropertyValueContract>>;
    applicationSearch?: ApplicationSearchRuntime;
    applicationSearchPageSubject?: string;
  }>,
): ReactElement | null {
  return <ApplicationSearchControl {...props} />;
}
