import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayHeader, resolveDisplayContext } from "./controls";
import { DisplayStateContainer } from "./display-state-container";
import { RichTextDocumentView } from "./rich-text";

/**
 * Shared browser-safe display component for validated structured rich text.
 * Renders caller-supplied projected rich text, or the block's declared literal `document`
 * setting when no projection is supplied, as React elements only: never raw HTML or
 * dangerouslySetInnerHTML. Never executes or fetches a Query.
 */
export function RichTextDisplay(props: PlatformBlockRenderProps): ReactElement {
  const literal = Object.hasOwn(props.settings, "document") ? props.settings.document : undefined;
  const effectiveProps: PlatformBlockRenderProps =
    props.projectedData === undefined && literal?.kind === "rich_text"
      ? {
          ...props,
          projectedData: {
            status: "ready",
            values: { kind: "rich_text", document: literal.value },
          },
        }
      : props;
  const { title, accessibleName, values, state, emptyMessage, events } = resolveDisplayContext(
    effectiveProps,
    "rich_text",
    (richText) => richText.document.blocks.length === 0,
    "No content to show",
  );

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={props.availability}
      projectedData={state}
      emptyMessage={emptyMessage}
    >
      {values === undefined ? null : (
        <div
          data-vortex-display="rich_text"
          data-vortex-placement-id={props.placementId}
          className="vortex-display-rich-text"
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <RichTextDocumentView document={values.document} />
        </div>
      )}
    </DisplayStateContainer>
  );
}
