import type { PlatformBlockRenderProps } from "../registry";
import { cellValueToText } from "./cell";
import { getAccessibleName } from "./display-state-container";
import type { DisplayDataState, DisplayEventHandlers, DisplayRow } from "./projected-data";

const EMPTY_STATE: DisplayDataState<never> = Object.freeze({ status: "empty" });

/**
 * The props a display block's renderer receives: the base props every block has, plus this block's
 * own `data` and `events`, which its own registration validated fail-closed. Both are optional
 * because a block with no projection and no bound callback simply receives neither.
 */
export type DisplayRenderProps<Values> = PlatformBlockRenderProps &
  Readonly<{ data?: DisplayDataState<Values>; events?: DisplayEventHandlers }>;

/** Resolved presentation context shared by every display component. */
export type DisplayContext<Values> = Readonly<{
  /** Authored accessible name, read only through the declared metadata path. */
  title: string | undefined;
  /** Authored name, or the block's palette name when the optional name is absent. */
  accessibleName: string;
  /** Ready values of this component's exact payload, or undefined for any other state. */
  values: Values | undefined;
  /** State passed to the state container; ready-but-empty content becomes the empty state. */
  state: DisplayDataState<Values>;
  /** Authored empty message, or the block family's fixed neutral default. */
  emptyMessage: string;
  /** Authored refused text, when the release declares `refused_message` and it is set. */
  refusedMessage: string | undefined;
  /** Authored error text, when the release declares `error_message` and it is set. */
  errorMessage: string | undefined;
  /** Semantic callbacks; always absent while the placement's use is unavailable. */
  events: DisplayEventHandlers | undefined;
}>;

/**
 * Resolves one display component's props from the inputs its own registration validated. Absent
 * projected data renders the empty state; the component never fetches its own data.
 */
export function resolveDisplayContext<Values>(
  props: DisplayRenderProps<Values>,
  isEmpty: (values: Values) => boolean,
  defaultEmptyMessage: string,
): DisplayContext<Values> {
  const { data, metadata, settings } = props;
  const values = data?.status === "ready" ? data.values : undefined;
  const title = getAccessibleName(settings, metadata);
  const authoredText = (key: string): string | undefined => {
    const value = settings[key];
    return value !== undefined && value.kind === "text" && value.value.trim().length > 0
      ? value.value.trim()
      : undefined;
  };
  const authoredEmptyMessage = settings["empty_message"];
  const emptyMessage =
    authoredEmptyMessage !== undefined &&
    authoredEmptyMessage.kind === "text" &&
    authoredEmptyMessage.value.trim().length > 0
      ? authoredEmptyMessage.value.trim()
      : defaultEmptyMessage;
  return {
    title,
    accessibleName: title ?? metadata.name,
    values,
    state: data === undefined || (values !== undefined && isEmpty(values)) ? EMPTY_STATE : data,
    emptyMessage,
    refusedMessage: authoredText("refused_message"),
    errorMessage: authoredText("error_message"),
    events: props.availability === "available" ? props.events : undefined,
  };
}

/** Plain-text row name from its heading cell, used for control labels instead of raw identities. */
export const rowName = (row: DisplayRow, headingKey: string | undefined): string => {
  const cell = headingKey === undefined ? undefined : row.cells[headingKey];
  const text = cell === undefined ? "" : cellValueToText(cell).trim();
  return text.length > 0 ? text : "untitled item";
};
