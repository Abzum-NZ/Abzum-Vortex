"use client";

import type { CSSProperties, ReactElement } from "react";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import { getAccessibleName } from "../display/display-state-container";
import { readControlSettings } from "../controls/control-context";

export type HeadingProps = PlatformBlockRenderProps;

type HeadingLevel = "one" | "two" | "three" | "four";

/** Heading levels map to the matching semantic element and a relative size against the theme. */
const HEADING_LEVEL_SCALES: Readonly<Record<HeadingLevel, string>> = Object.freeze({
  one: "1",
  two: "0.875",
  three: "0.75",
  four: "0.625",
});

/**
 * Accessible heading whose text is the authored, required accessible name. It renders the
 * semantic heading element for its declared level using the platform heading typography, so a
 * shell header or a page section is real content rather than a styled paragraph. It carries no
 * data and emits no events.
 */
export function Heading(props: HeadingProps): ReactElement {
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
      "The heading block does not accept data or semantic events",
      location,
    );

  const text = getAccessibleName(props.settings, props.metadata);
  if (text === undefined)
    throw new DefinitionRenderError(
      "MISSING_ACCESSIBLE_NAME",
      "The heading block requires non-blank heading text",
      location,
    );

  const level = readControlSettings(props, location).choice<HeadingLevel>("level", "two");
  const scale = HEADING_LEVEL_SCALES[level];
  const style: CSSProperties = {
    margin: 0,
    fontFamily: "var(--vortex-heading-font-family)",
    fontSize:
      scale === "1"
        ? "var(--vortex-heading-font-size)"
        : `calc(var(--vortex-heading-font-size) * ${scale})`,
    lineHeight: "var(--vortex-heading-line-height)",
    fontWeight: "var(--vortex-heading-font-weight)",
    color: "var(--vortex-text)",
  };
  const className = `vortex-heading vortex-heading-${level}`;

  switch (level) {
    case "one":
      return (
        <h1
          data-vortex-control="heading"
          data-vortex-placement-id={props.placementId}
          data-vortex-level={level}
          className={className}
          style={style}
        >
          {text}
        </h1>
      );
    case "three":
      return (
        <h3
          data-vortex-control="heading"
          data-vortex-placement-id={props.placementId}
          data-vortex-level={level}
          className={className}
          style={style}
        >
          {text}
        </h3>
      );
    case "four":
      return (
        <h4
          data-vortex-control="heading"
          data-vortex-placement-id={props.placementId}
          data-vortex-level={level}
          className={className}
          style={style}
        >
          {text}
        </h4>
      );
    case "two":
    default:
      return (
        <h2
          data-vortex-control="heading"
          data-vortex-placement-id={props.placementId}
          data-vortex-level={level}
          className={className}
          style={style}
        >
          {text}
        </h2>
      );
  }
}
