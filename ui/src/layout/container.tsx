"use client";

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings } from "../controls/control-context";

export type ContainerProps = PlatformBlockRenderProps;

type ContainerDirection = "column" | "row";
type ContainerGap = "none" | "small" | "medium" | "large";

/** Declared child slots in deterministic render order, each with its region class. */
const CONTAINER_REGIONS = [
  { key: "header", className: "vortex-container-header" },
  { key: "menu", className: "vortex-container-menu" },
  { key: "content", className: "vortex-container-content" },
] as const;

/** Named gaps resolve to the shared spacing tokens, so a container follows the active theme. */
const CONTAINER_GAPS: Readonly<Record<ContainerGap, string>> = Object.freeze({
  none: "0",
  small: "var(--vortex-space-sm)",
  medium: "var(--vortex-space-md)",
  large: "var(--vortex-space-lg)",
});

/**
 * General layout container: arranges its declared header, menu and content slots in a row or a
 * column with a token-driven gap. It carries no data and emits no events; it only lays out the
 * placements an author supplies or a shell binds as page content. A shell can therefore expose
 * header, menu and content slots without borrowing the tabs block.
 */
export function Container(props: ContainerProps): ReactElement {
  const location: DefinitionRenderErrorLocation = {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  };
  if (
    props.projectedData !== undefined ||
    props.displayEvents !== undefined ||
    props.controlData !== undefined ||
    props.controlEvents !== undefined
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "The container block does not accept data or semantic events",
      location,
    );

  const settings = readControlSettings(props, location);
  const direction = settings.choice<ContainerDirection>("direction", "column");
  const gap = settings.choice<ContainerGap>("gap", "medium");

  const regionStyle: CSSProperties =
    direction === "row" ? { flex: "1 1 0", minWidth: 0 } : { minWidth: 0 };

  const regions: ReactNode[] = [];
  for (const region of CONTAINER_REGIONS) {
    const child = props.slots[region.key];
    if (child === undefined || child === null) continue;
    regions.push(
      <div
        key={region.key}
        data-vortex-container-region={region.key}
        className={region.className}
        style={regionStyle}
      >
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
      className="vortex-container"
      style={{
        display: "flex",
        flexDirection: direction,
        gap: CONTAINER_GAPS[gap],
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      {regions}
    </div>
  );
}
