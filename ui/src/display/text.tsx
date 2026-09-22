import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { DisplayCellView } from "./cell";
import { DisplayHeader, resolveDisplayContext } from "./controls";
import { DisplayStateContainer } from "./display-state-container";

/**
 * Shared browser-safe display component for plain text.
 * Renders caller-supplied projected text, or the block's declared literal `text` setting when
 * no projection is supplied. Never executes or fetches a Query.
 */
export function PlainTextDisplay(props: PlatformBlockRenderProps): ReactElement {
  const literal = Object.hasOwn(props.settings, "text") ? props.settings.text : undefined;
  const effectiveProps: PlatformBlockRenderProps =
    props.projectedData === undefined && literal?.kind === "text" && literal.value.length > 0
      ? {
          ...props,
          projectedData: {
            status: "ready",
            values: { kind: "text", value: { kind: "text", text: literal.value } },
          },
        }
      : props;
  const { title, accessibleName, values, state, events } = resolveDisplayContext(
    effectiveProps,
    "text",
    (text) => text.value.kind === "empty",
  );

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={props.availability}
      projectedData={state}
      emptyMessage="No text to show"
    >
      {values === undefined ? null : (
        <div
          data-vortex-display="text"
          data-vortex-placement-id={props.placementId}
          className="vortex-display-text"
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <div className="vortex-text-value">
            <DisplayCellView value={values.value} />
          </div>
        </div>
      )}
    </DisplayStateContainer>
  );
}
