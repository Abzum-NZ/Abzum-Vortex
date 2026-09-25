import { useState, type ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import { cellValueToText } from "./cell";
import { getAccessibleName } from "./display-state-container";
import type {
  DisplayCellValue,
  DisplayEventHandler,
  DisplayEventHandlers,
  DisplayRow,
  ProjectedDisplayData,
  ProjectedDisplayValueKind,
  ProjectedDisplayValues,
} from "./projected-data";

const EMPTY_STATE: ProjectedDisplayData = Object.freeze({ status: "empty" });

/** Resolved presentation context shared by every display component. */
export type DisplayContext<Kind extends ProjectedDisplayValueKind> = Readonly<{
  /** Authored accessible name, read only through the declared metadata path. */
  title: string | undefined;
  /** Authored name, or the block's palette name when the optional name is absent. */
  accessibleName: string;
  /** Ready values of this component's exact kind, or undefined for any other state. */
  values: Extract<ProjectedDisplayValues, { kind: Kind }> | undefined;
  /** State passed to the state container; ready-but-empty content becomes the empty state. */
  state: ProjectedDisplayData;
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
 * Resolves one display component's props. Ready values of another kind fail closed.
 * Absent projected data renders the empty state; the component never fetches its own data.
 */
export function resolveDisplayContext<Kind extends ProjectedDisplayValueKind>(
  props: PlatformBlockRenderProps,
  kind: Kind,
  isEmpty: (values: Extract<ProjectedDisplayValues, { kind: Kind }>) => boolean,
  defaultEmptyMessage: string,
): DisplayContext<Kind> {
  const { projectedData, metadata, settings, placementId } = props;
  if (props.controlData !== undefined || props.controlEvents !== undefined) {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Display block '${metadata.key}' does not accept control data or control events`,
      { placementId, blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
    );
  }
  let values: Extract<ProjectedDisplayValues, { kind: Kind }> | undefined;
  if (projectedData?.status === "ready") {
    if (projectedData.values.kind !== kind) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Block '${metadata.key}' expected '${kind}' projected values, got '${projectedData.values.kind}'`,
        { placementId, blockId: metadata.blockId, releaseVersion: metadata.releaseVersion },
      );
    }
    values = projectedData.values as Extract<ProjectedDisplayValues, { kind: Kind }>;
  }
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
    state:
      projectedData === undefined || (values !== undefined && isEmpty(values))
        ? EMPTY_STATE
        : projectedData,
    emptyMessage,
    refusedMessage: authoredText("refused_message"),
    errorMessage: authoredText("error_message"),
    events: props.availability === "available" ? props.displayEvents : undefined,
  };
}

/** Plain-text row name from its heading cell, used for control labels instead of raw identities. */
export const rowName = (row: DisplayRow, headingKey: string | undefined): string => {
  const cell = headingKey === undefined ? undefined : row.cells[headingKey];
  const text = cell === undefined ? "" : cellValueToText(cell).trim();
  return text.length > 0 ? text : "untitled item";
};

/** Optional authored title with a refresh control bound to the declared `refresh` event. */
export function DisplayHeader({
  title,
  accessibleName,
  events,
}: Readonly<{
  title: string | undefined;
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const refresh = events?.refresh;
  if (title === undefined && refresh === undefined) return null;
  return (
    <div className="vortex-display-header">
      {title === undefined ? null : <h2 className="vortex-display-title">{title}</h2>}
      {refresh === undefined ? null : (
        <button
          type="button"
          className="vortex-button-refresh"
          aria-label={`Refresh ${accessibleName}`}
          onClick={() => refresh({ event: "refresh" })}
        >
          Refresh
        </button>
      )}
    </div>
  );
}

/** Selection checkbox bound to the declared `selection_changed` event and stable record identity. */
export function SelectionControl({
  row,
  name,
  selected,
  events,
}: Readonly<{
  row: DisplayRow;
  name: string;
  selected: boolean;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onSelection = events?.selection_changed;
  if (onSelection === undefined) return null;
  return (
    <input
      type="checkbox"
      className="vortex-selection-checkbox"
      aria-label={`Select ${name}`}
      checked={selected}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) =>
        onSelection({
          event: "selection_changed",
          recordId: row.recordId,
          selected: event.currentTarget.checked,
        })
      }
    />
  );
}

/**
 * Row command bound to the declared `row_action` event; the bound flow decides its meaning. A
 * declared action carries the stable identity of its own binding, so several named commands on one
 * table reach different flows. An earlier release that declares no named action keeps the one
 * legacy control, identified by the placement itself.
 */
export function RowActionControl({
  recordId,
  name,
  eventId,
  label,
  events,
}: Readonly<{
  recordId: string;
  name: string;
  eventId?: string;
  label?: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onRowAction = events?.row_action;
  if (onRowAction === undefined) return null;
  const text = label ?? "Open";
  return (
    <button
      type="button"
      className="vortex-button-row-action"
      aria-label={`${text} ${name}`}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onRowAction(
          eventId === undefined
            ? { event: "row_action", recordId }
            : { event: "row_action", eventId, recordId },
        );
      }}
    >
      {text}
    </button>
  );
}

/**
 * One bulk command over the current selection. It is disabled until at least one row is selected,
 * and it sends the selected record identities as a bounded list, never an implicit first record.
 */
export function BulkActionControl({
  eventId,
  label,
  recordIds,
  events,
}: Readonly<{
  eventId: string;
  label: string;
  recordIds: readonly string[];
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const onBulkAction = events?.bulk_action;
  if (onBulkAction === undefined) return null;
  return (
    <button
      type="button"
      className="vortex-button-bulk-action"
      disabled={recordIds.length === 0}
      onClick={() =>
        onBulkAction({ event: "bulk_action", eventId, recordIds: [...recordIds] })
      }
    >
      {label}
    </button>
  );
}

/**
 * One in-place editor for a declared permitted field. It commits the edited value as the table's
 * declared `inline_edit` event carrying the stable identity of the commit binding, the record, the
 * field and the new closed value. Record revisions are not part of the query rows today, so no
 * revision is sent and the server re-checks the change and refuses a stale one.
 */
export function InlineEditCell({
  eventId,
  recordId,
  field,
  label,
  value,
  handler,
}: Readonly<{
  eventId: string;
  recordId: string;
  field: string;
  label: string;
  value: DisplayCellValue;
  handler: DisplayEventHandler;
}>): ReactElement {
  const [text, setText] = useState(() =>
    value.kind === "number" ? String(value.value) : value.kind === "boolean" ? "" : cellValueToText(value),
  );
  const [checked, setChecked] = useState(value.kind === "boolean" ? value.value : false);
  const commitText = (): void => {
    if (value.kind === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || text.trim().length === 0) return;
      handler({
        event: "inline_edit",
        eventId,
        recordId,
        field,
        value: { kind: "number", value: parsed },
      });
      return;
    }
    handler({ event: "inline_edit", eventId, recordId, field, value: { kind: "text", text } });
  };
  if (value.kind === "boolean")
    return (
      <input
        type="checkbox"
        className="vortex-inline-edit-checkbox"
        aria-label={`Edit ${label}`}
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          setChecked(next);
          handler({
            event: "inline_edit",
            eventId,
            recordId,
            field,
            value: { kind: "boolean", value: next },
          });
        }}
      />
    );
  return (
    <input
      type={value.kind === "number" ? "number" : "text"}
      className="vortex-inline-edit-input"
      aria-label={`Edit ${label}`}
      value={text}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commitText}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commitText();
        }
      }}
    />
  );
}

/** Page position with previous/next controls bound to the declared `page_changed` event. */
export function PaginationControl({
  page,
  pageCount,
  accessibleName,
  events,
}: Readonly<{
  page: number | undefined;
  pageCount: number | undefined;
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  if (page === undefined || pageCount === undefined) return null;
  const onPage = events?.page_changed;
  return (
    <nav className="vortex-pagination" aria-label={`Pages of ${accessibleName}`}>
      <span className="vortex-pagination-info">
        Page {page} of {pageCount}
      </span>
      {onPage === undefined ? null : (
        <>
          <button
            type="button"
            className="vortex-pagination-prev"
            disabled={page <= 1}
            onClick={() => onPage({ event: "page_changed", page: page - 1 })}
          >
            Previous page
          </button>
          <button
            type="button"
            className="vortex-pagination-next"
            disabled={page >= pageCount}
            onClick={() => onPage({ event: "page_changed", page: page + 1 })}
          >
            Next page
          </button>
        </>
      )}
    </nav>
  );
}
