"use client";

import { useId, type ReactElement, type ReactNode } from "react";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { LAYOUT_BREAKPOINT_MEDIA } from "../layout-styles";
import { cn } from "../lib/utils";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings } from "../controls/control-context";

export type ContainerProps = PlatformBlockRenderProps;

type ContainerDirection = "column" | "row";
type ContainerGap = "none" | "small" | "medium" | "large";
type ContainerContentWidth = "fill" | "readable";
type MenuPlacement = "flow" | "sticky" | "full_height";
type ContainerGeometry = Readonly<{
  direction: ContainerDirection;
  menuWidth: number | undefined;
  menuPlacement: MenuPlacement;
}>;

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

const CONTAINER_PADDING: Readonly<Record<ContainerGap, string>> = Object.freeze({
  none: "p-0",
  small: "p-2",
  medium: "p-4",
  large: "p-6",
});

/** CSS is scoped to one rendered container, including two previews of the same placement. */
function geometryCss(scope: string, geometry: ContainerGeometry): string {
  const root = `[data-vortex-container-scope="${scope}"]`;
  const menu = `${root} > [data-vortex-container-region="menu"]`;
  const content = `${root} > [data-vortex-container-region="content"]`;
  const header = `${root} > [data-vortex-container-region="header"]`;
  const row = geometry.direction === "row";
  const menuWidth =
    row && geometry.menuWidth !== undefined ? `${geometry.menuWidth}rem` : undefined;
  const placement =
    geometry.menuPlacement === "sticky"
      ? "position:sticky;top:0;min-height:0;max-height:100svh;overflow-y:auto;align-self:flex-start"
      : geometry.menuPlacement === "full_height"
        ? "position:static;min-height:100svh;max-height:none;overflow-y:visible;align-self:stretch"
        : "position:static;min-height:0;max-height:none;overflow-y:visible;align-self:auto";
  return [
    `${root}{display:flex;flex-direction:${geometry.direction};width:100%;min-width:0}`,
    `${header}{width:${row ? "auto" : "100%"};flex:none}`,
    `${menu}{flex:${menuWidth === undefined ? "none" : `0 0 ${menuWidth}`};width:${menuWidth ?? (row ? "auto" : "100%")};max-width:100%;${placement}}`,
    `${content}{flex:${row ? "1 1 0%" : "none"};width:${row ? "auto" : "100%"};min-width:0}`,
  ].join("\n");
}

/**
 * General layout container: arranges its declared header, menu and content slots in a row or a
 * column with a gap from the shadcn spacing scale. It carries no data and emits no events; it only
 * lays out the placements an author supplies or a shell binds as page content. A shell can
 * therefore expose header, menu and content slots without borrowing the tabs block. Its
 * registration refuses every supplied runtime input.
 */
export function Container(props: ContainerProps): ReactElement {
  const scope = useId();
  const location: DefinitionRenderErrorLocation = {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  };

  const settings = readControlSettings(props, location);
  const direction = settings.choice<ContainerDirection>("direction", "column");
  const gap = settings.choice<ContainerGap>("gap", "medium");
  const declared = new Set(props.metadata.properties.map((property) => property.key));
  const menuGeometryDeclared = declared.has("menu_width");
  const contentLandmark = declared.has("content_landmark") && settings.boolean("content_landmark");
  const readWidth = (key: string): number | undefined =>
    declared.has(key) ? settings.number(key) : undefined;
  const readChoice = <Value extends string>(key: string, fallback: Value): Value =>
    declared.has(key) ? settings.choice(key, fallback) : fallback;
  const padding = readChoice<ContainerGap>("padding", "none");
  const contentWidth = readChoice<ContainerContentWidth>("content_width", "fill");
  const desktop: ContainerGeometry = {
    direction,
    menuWidth: readWidth("menu_width"),
    menuPlacement: readChoice<MenuPlacement>("menu_placement", "flow"),
  };
  const tabletDirection = readChoice<ContainerDirection | "inherit">("tablet_direction", "inherit");
  const tabletPlacement = readChoice<MenuPlacement | "inherit">("tablet_menu_placement", "inherit");
  const tablet: ContainerGeometry = {
    direction: tabletDirection === "inherit" ? desktop.direction : tabletDirection,
    menuWidth: readWidth("tablet_menu_width") ?? desktop.menuWidth,
    menuPlacement: tabletPlacement === "inherit" ? desktop.menuPlacement : tabletPlacement,
  };
  const phoneDirection = readChoice<ContainerDirection | "inherit">("phone_direction", "inherit");
  const phonePlacement = readChoice<MenuPlacement | "inherit">("phone_menu_placement", "inherit");
  const phone: ContainerGeometry = {
    direction: phoneDirection === "inherit" ? tablet.direction : phoneDirection,
    menuWidth: readWidth("phone_menu_width") ?? tablet.menuWidth,
    menuPlacement: phonePlacement === "inherit" ? tablet.menuPlacement : phonePlacement,
  };
  const responsiveCss = props.responsiveLayout
    ? `${geometryCss(scope, desktop)}\n@media ${LAYOUT_BREAKPOINT_MEDIA.tablet}{${geometryCss(scope, tablet)}}\n@media ${LAYOUT_BREAKPOINT_MEDIA.phone}{${geometryCss(scope, phone)}}`
    : geometryCss(scope, { desktop, tablet, phone }[props.breakpoint]);

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
    const Region = region === "content" && contentLandmark ? "main" : "div";
    regions.push(
      <Region key={region} data-vortex-container-region={region} className={regionClassName(region)}>
        {child}
      </Region>,
    );
  }

  return (
    <div
      data-vortex-control="container"
      data-vortex-direction={direction}
      data-vortex-gap={gap}
      {...(menuGeometryDeclared ? { "data-vortex-container-scope": scope } : {})}
      className={cn(
        "box-border flex w-full",
        direction === "row" ? "flex-row" : "flex-col",
        CONTAINER_GAPS[gap],
        declared.has("padding") ? CONTAINER_PADDING[padding] : undefined,
        contentWidth === "readable" ? "mx-auto max-w-2xl" : undefined,
      )}
    >
      {menuGeometryDeclared ? <style>{responsiveCss}</style> : null}
      {regions}
    </div>
  );
}
