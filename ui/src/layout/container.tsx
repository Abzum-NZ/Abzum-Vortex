"use client";

import type { ReactElement, ReactNode } from "react";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { cn } from "../lib/utils";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings } from "../controls/control-context";

export type ContainerProps = PlatformBlockRenderProps;

type ContainerDirection = "column" | "row";
type ContainerGap = "none" | "small" | "medium" | "large";

/** Declared child slots in deterministic render order. */
const CONTAINER_REGIONS = ["header", "menu", "content"] as const;

type ContainerRegionKey = (typeof CONTAINER_REGIONS)[number];

/** Named gaps resolve to the shadcn spacing scale, so a container follows the active style. */
const CONTAINER_GAPS: Readonly<Record<ContainerGap, string>> = Object.freeze({
  none: "gap-0",
  small: "gap-2",
  medium: "gap-4",
  large: "gap-6",
});

/**
 * General layout container: arranges its declared header, menu and content slots in a row or a
 * column with a gap from the shadcn spacing scale. It carries no data and emits no events; it only
 * lays out the placements an author supplies or a shell binds as page content. A shell can
 * therefore expose header, menu and content slots without borrowing the tabs block. Its
 * registration refuses every supplied runtime input.
 */
export function Container(props: ContainerProps): ReactElement {
  const location: DefinitionRenderErrorLocation = {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  };

  const settings = readControlSettings(props, location);
  const direction = settings.choice<ContainerDirection>("direction", "column");
  const gap = settings.choice<ContainerGap>("gap", "medium");

  // In a row, header and menu keep their content width and content fills the remaining space, so
  // a menu beside page content reads as a sidebar rather than an equal third.
  const regionClassName = (key: ContainerRegionKey): string =>
    direction === "row"
      ? cn("min-w-0", key === "content" ? "flex-1 basis-0" : "flex-none")
      : "min-w-0";

  const regions: ReactNode[] = [];
  for (const region of CONTAINER_REGIONS) {
    const child = props.slots[region];
    if (child === undefined || child === null) continue;
    regions.push(
      <div key={region} data-vortex-container-region={region} className={regionClassName(region)}>
        {child}
      </div>,
    );
  }

  return (
    <div
      data-vortex-control="container"
      data-vortex-placement-id={props.placementId}
      data-vortex-direction={direction}
      data-vortex-gap={gap}
      className={cn(
        "box-border flex w-full",
        direction === "row" ? "flex-row" : "flex-col",
        CONTAINER_GAPS[gap],
      )}
    >
      {regions}
    </div>
  );
}
