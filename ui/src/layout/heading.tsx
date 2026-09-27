"use client";

import type { ReactElement } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { cn } from "../lib/utils";
import type { PlatformBlockRenderProps } from "../registry";
import { getAccessibleName } from "../display/display-state-container";
import { readControlSettings } from "../controls/control-context";

export type HeadingProps = PlatformBlockRenderProps;

type HeadingLevel = "one" | "two" | "three" | "four";

/** Each declared level renders its matching semantic heading element. */
const HEADING_LEVEL_ELEMENTS: Readonly<Record<HeadingLevel, "h1" | "h2" | "h3" | "h4">> =
  Object.freeze({ one: "h1", two: "h2", three: "h3", four: "h4" });

/**
 * Each level's shadcn typography classes. The heading font is the resolved theme's heading font
 * (`font-heading`); size, weight and tracking follow the shadcn typography scale.
 */
const HEADING_LEVEL_CLASSES: Readonly<Record<HeadingLevel, string>> = Object.freeze({
  one: "text-2xl font-semibold tracking-tight text-balance",
  two: "text-xl font-semibold tracking-tight",
  three: "text-lg font-semibold",
  four: "text-base font-semibold",
});

/**
 * Accessible heading whose text is the authored, required accessible name. It renders the
 * semantic heading element for its declared level with the shadcn typography classes, so a
 * shell header or a page section is real content rather than a styled paragraph. It carries no
 * data and emits no events; its registration refuses every supplied runtime input.
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

  const level = readControlSettings(props, location).choice<HeadingLevel>("level", "two");
  const Element = HEADING_LEVEL_ELEMENTS[level];
  return (
    <Element
      data-vortex-control="heading"
      data-vortex-placement-id={props.placementId}
      data-vortex-level={level}
      className={cn("m-0 scroll-m-20 font-heading text-foreground", HEADING_LEVEL_CLASSES[level])}
    >
      {text}
    </Element>
  );
}
