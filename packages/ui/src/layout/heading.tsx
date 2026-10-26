"use client";

import type { ReactElement } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { cn } from "../lib/utils";
import type { PlatformBlockRenderProps } from "../registry";
import { getAccessibleName } from "../display/display-state-container";
import { readControlSettings } from "../controls/control-context";

export type HeadingProps = PlatformBlockRenderProps;

/** The page's one level-1 heading is its name, drawn by the application shell. */
type HeadingLevel = "two" | "three" | "four";

/** Each declared level renders its matching semantic heading element. */
const HEADING_LEVEL_ELEMENTS: Readonly<Record<HeadingLevel, "h2" | "h3" | "h4">> = Object.freeze({
  two: "h2",
  three: "h3",
  four: "h4",
});

/**
 * Each level's shadcn typography classes. The heading font is the resolved theme's heading font
 * (`font-heading`); size, weight and tracking follow the shadcn typography scale.
 */
const HEADING_LEVEL_CLASSES: Readonly<Record<HeadingLevel, string>> = Object.freeze({
  two: "text-xl font-semibold tracking-tight",
  three: "text-lg font-semibold",
  four: "text-base font-semibold",
});

/**
 * Accessible heading whose text is the authored, required accessible name. It renders the
 * semantic heading element for its declared level with the shadcn typography classes, so a
 * shell header or a page section is real content rather than a styled paragraph. It carries no
 * data and emits no events; its registration refuses every supplied runtime input. Its optional
 * actions slot places the actions that belong to the title (for example "New asset") at the right
 * of the title row.
 */
export function Heading(props: HeadingProps): ReactElement {
  const location: DefinitionRenderErrorLocation = {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  };

  const text = getAccessibleName(props.settings, props.metadata);
  if (text === undefined)
    throw new DefinitionRenderError(
      "MISSING_ACCESSIBLE_NAME",
      "The heading block requires non-blank heading text",
      location,
    );

  const level = readControlSettings(props, location).explicitChoice<HeadingLevel>("level");
  const Element = HEADING_LEVEL_ELEMENTS[level];
  const heading = (
    <Element
      data-vortex-control="heading"
      data-vortex-placement-id={props.placementId}
      data-vortex-level={level}
      className={cn("m-0 scroll-m-20 font-heading text-foreground", HEADING_LEVEL_CLASSES[level])}
    >
      {text}
    </Element>
  );
  const actions = props.slots.actions;
  if (actions === undefined || actions === null) return heading;
  // The title stays on the left and the actions that belong to it sit at the right of the same row.
  return (
    <div
      data-vortex-control="heading-row"
      className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      {heading}
      <div data-vortex-heading-actions="" className="flex flex-wrap items-center gap-2">
        {actions}
      </div>
    </div>
  );
}
