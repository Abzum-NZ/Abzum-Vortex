import type { ReactElement } from "react";
import { DisplayCellView } from "./cell";
import { DisplayHeader } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { TextPayload } from "./projected-data";

/**
 * Shared browser-safe display component for plain text.
 * Renders caller-supplied projected text, or the block's declared literal `text` setting when
 * no projection is supplied. Never executes or fetches a Query.
 */
export function PlainTextDisplay(props: DisplayRenderProps<TextPayload>): ReactElement {
  const literal = Object.hasOwn(props.settings, "text") ? props.settings.text : undefined;
  const effectiveProps: DisplayRenderProps<TextPayload> =
    props.data === undefined && literal?.kind === "text" && literal.value.length > 0
      ? {
          ...props,
          data: {
            status: "ready",
            values: { kind: "text", value: { kind: "text", text: literal.value } },
          },
        }
      : props;
  const { title, accessibleName, values, state, emptyMessage, events } =
    resolveDisplayContext<TextPayload>(
      effectiveProps,
      (text) => text.value.kind === "empty",
      "No text to show",
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
