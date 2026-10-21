import {
  type FlowFieldCorrection,
  type JsonValue,
  type BoardColumnSelector,
  type ComponentSemanticEventKind,
  type RecordsTableSortKey,
  type RecordsTableBatchEditRequest,
  type RecordsTableBatchEditResult,
  type GridLayout,
  type GridViewCommand,
} from "@vortex/platform/schema";
import { type TableSelectionEvent } from "./projected-grid-features";

/** Declared semantic event names this display family can emit. */
export type DisplaySemanticEventName =
  | Extract<
      ComponentSemanticEventKind,
      | "refresh"
      | "row_clicked"
      | "row_action"
      | "selection_changed"
      | "filter_changed"
      | "search_changed"
      | "sort_changed"
      | "columns_changed"
      | "page_changed"
      | "bulk_action"
      | "inline_edit"
      | "row_edit"
      | "card_moved"
      | "card_added"
      | "row_expanded"
    >
  /**
   * A Records table's link picker (a column filter or a cell editor) asks the page for one bounded
   * page of the field's target records, and its Bulk actions widen or clear the selection; neither
   * is a flow event.
   */
  | "table_records_requested"
  | "selection_scope_changed"
  /**
   * A Records table's Export asks the page to download a file of the chosen records, or to stop
   * the download in progress. The page streams the file from the server; neither is a flow event.
   */
  | "export_requested"
  | "export_cancelled"
  /**
   * A Records table's status bar asks the page for the totals of the selected range of the shown
   * page; the handler resolves to the server's answer. It is a read, not a flow event.
   */
  | "range_summary_requested"
  /**
   * A Records table's Paste, Fill and Undo send one batch of cell changes (or undo or redo the last
   * batch the person committed) and read the depth of the session's undo stack. The page posts the
   * batch to the server, which validates every cell and commits all or nothing. Not a flow event.
   */
  | "batch_edit_requested"
  /**
   * A Records table's pivot asks for one page of its rows, opens the pivot or closes it, or a cell
   * opens the ordinary grid on the records it counts. These are the Pivot feature's own reads and
   * address changes, not flow events.
   */
  | "pivot_requested"
  | "pivot_view_changed"
  | "pivot_drilled"
  /**
   * A grouped table's person groups or ungroups it (an address change that reads the groups), asks
   * for one page of an open group's members, or opens or closes a group (kept in the address
   * without a read). These are the Group by feature's own reads and address changes, not flow events.
   */
  | "group_changed"
  | "group_page_changed"
  | "group_requested"
  | "group_opened"
  /** The Saved views feature asks the host to open, store, share or delete a view. */
  | "grid_view_requested";

/**
 * One declared semantic event. Row and item events always carry stable identity;
 * no event is ever emitted without a real user interaction. The bound flow, not the
 * component, decides what a row action does.
 *
 * A row click, row action, bulk action and inline-edit commit carry the stable `eventId` of the
 * exact configured control that fired, because one table placement may declare several named
 * commands that each bind to a different flow. A block without a row-action list names its one row
 * action in its required `row_action_event_id` setting, and every `row_action` it emits carries it.
 *
 * A row action carries the row's server-projected current revision, exactly as an inline-edit commit
 * does, so a command that changes one existing row is bound at the revision the person actually saw
 * and the server still refuses a stale one. The value is never typed by the person.
 */
export type DisplaySemanticEvent =
  | Readonly<{ event: "refresh" }>
  | Readonly<{ event: "row_clicked"; eventId: string; recordId: string }>
  | Readonly<{
      event: "row_action";
      eventId: string;
      recordId: string;
      /** The record revision the row was read at; a stale one is refused by the server. */
      revision?: number;
    }>
  | TableSelectionEvent
  | Readonly<{
      event: "filter_changed";
      /** The filterable field whose control changed. */
      field: string;
      /** The address spelling of the field's typed filter; empty clears that field's filter. */
      value: string;
    }>
  | Readonly<{
      event: "table_records_requested";
      /** The link field whose target records the picker offers. */
      field: string;
      /** Why the records are read: to filter by them, or to choose one in an edited cell. */
      purpose: "filter" | "edit";
      /** For a dependent link field: the record chosen in the field it depends on, in the draft. */
      parentRecordId?: string;
      search?: string;
      continuationToken?: string;
    }>
  | Readonly<{ event: "search_changed"; query: string }>
  | Readonly<{
      event: "pivot_requested";
      /** The opaque position of the first row of the page; absent reads the first rows. */
      cursor?: string;
    }>
  | Readonly<{
      event: "pivot_view_changed";
      /** The view to keep in the address: absent shows the ordinary grid. */
      view: Readonly<{ cursor?: string }> | undefined;
    }>
  | Readonly<{
      /** Groups the table by its authored field, or (null) shows the records ungrouped. */
      event: "group_changed";
      grouped: boolean;
    }>
  | Readonly<{
      /** Shows another page of the groups: the position of the page before it, or null for the first. */
      event: "group_page_changed";
      after: string | null;
    }>
  | Readonly<{
      /** Asks for one page of the members of one group; its handler resolves to that page. */
      event: "group_requested";
      key: string;
      /** The token of the page before, to read another page; absent for the first page. */
      continuationToken?: string;
      direction?: "forward" | "backward";
    }>
  | Readonly<{
      /** The group that is open now (null when every group is closed), to keep in the address. */
      event: "group_opened";
      key: string | null;
    }>
  | Readonly<{
      event: "pivot_drilled";
      /** The typed filters (address spelling) that select the cell's records in the ordinary grid. */
      filters: readonly Readonly<{ fieldId: string; filter: string }>[];
    }>
  | Readonly<{
      /**
       * A person asked for a change to the grid's saved views. The host opens the view in the
       * address or stores the change, and its handler resolves to a `GridViewCommandResult`.
       */
      event: "grid_view_requested";
      command: GridViewCommand;
    }>
  | Readonly<{
      /** The whole ordered sort a header asked for; an empty list asks for the default order. */
      event: "sort_changed";
      sort: readonly RecordsTableSortKey[];
    }>
  | Readonly<{
      /**
       * A person committed a change to the grid's layout (order, shown columns, widths, density).
       * The host stores it, reading no records; its handler resolves to a `GridLayoutCommitResult`.
       */
      event: "columns_changed";
      /** The layout to store, or null to remove the person's layout (Reset layout). */
      layout: GridLayout | null;
      /** The stored revision the change was made from; null when none is stored. */
      expectedRevision: number | null;
      /** The query the grid reads, as the page carried it. */
      queryId: string;
    }>
  | Readonly<{
      event: "page_changed";
      page: number;
      direction: "first" | "previous" | "next" | "last";
      continuationToken?: string;
    }>
  | Readonly<{
      event: "page_changed";
      columns: readonly BoardColumnSelector[];
      continuationToken?: string;
    }>
  /**
   * Asks for the totals of the selected range: the shown page's record identities and the columns
   * the status bar offers. The handler resolves to a `RecordsRangeSummaryResult`; `signal` aborts
   * a request the range has moved past.
   */
  | Readonly<{
      event: "range_summary_requested";
      recordIds: readonly string[];
      fieldIds: readonly string[];
      signal: AbortSignal;
    }>
  /**
   * A batch of cell changes on the shown page (`commit`), the inverse of the last committed batch
   * (`undo`), that inverse undone again (`redo`), or just the stack depths (`state`). The handler
   * resolves to a `DisplayBatchEditAnswer`.
   */
  | Readonly<{
      event: "batch_edit_requested";
      action: "commit" | "undo" | "redo" | "state";
      /** The rows of a `commit`: record, displayed revision and the cells it changes. */
      rows?: RecordsTableBatchEditRequest["rows"];
    }>
  | Readonly<{
      event: "row_edit";
      eventId: string;
      recordId: string;
      revision: number;
      values: Readonly<Record<string, JsonValue>>;
      commandId: string;
    }>
  | Readonly<{
      event: "inline_edit";
      eventId: string;
      recordId: string;
      /** The record revision the row was displayed at; the writer refuses a stale one. */
      revision: number;
      /** The field's key as the table's column names it. */
      field: string;
      /** The new stored value in the field's own contract (null clears it). */
      value: JsonValue;
      /** One identity for this explicit commit, so a repeated request is the same write. */
      commandId: string;
    }>
  | Readonly<{
      /**
       * A board card dropped into another column. It carries the record, the revision the card was
       * read at, the key of the board's choice field and the target column's option value; the
       * bound flow saves that field through the normal record save.
       */
      event: "card_moved";
      recordId: string;
      revision?: number;
      field: string;
      value: string;
    }>
  | Readonly<{
      /**
       * A person asked to add a card to a column. It carries the column's option value; the bound
       * flow opens the create form with that stage chosen, and the record is created there.
       */
      event: "card_added";
      field: string;
      value: string;
    }>
  | Readonly<{
      /**
       * A person expanded a row (or asked for more of its related records). The host reads one page
       * of that row's related records on the server; its handler resolves to that page.
       */
      event: "row_expanded";
      recordId: string;
      /** The token of the page before, to read the next page; absent for the first page. */
      continuationToken?: string;
      /** Remaining room in the shared row budget; can only narrow the authored page size. */
      pageSize?: number;
    }>;

/**
 * What one commit of an inline edit came to, told by the host once the server answered: saved, or
 * not saved with the safe sentence to show on the cell. `changed` says the record changed under
 * the person, so their draft is kept until they reload and retry. Nothing is ever shown as saved
 * before the server confirmed it.
 */
export type DisplayInlineEditResult =
  | Readonly<{ kind: "saved" }>
  | Readonly<{
      kind: "refused";
      message: string;
      changed: boolean;
      corrections?: readonly FlowFieldCorrection[];
    }>;

/** What a batch edit request came to, with how many batches the session can now undo and redo. */
export type DisplayBatchEditAnswer = Readonly<{
  result: RecordsTableBatchEditResult | undefined;
  undoDepth: number;
  redoDepth: number;
}>;

/** A handler may return the promise of the flow it started; the control stays busy until it settles. */
export type DisplayEventHandler = (event: DisplaySemanticEvent) => void | Promise<unknown>;

/** Callbacks accepted by one placement, keyed only by declared event name. */
export type DisplayEventHandlers = Readonly<
  Partial<Record<DisplaySemanticEventName, DisplayEventHandler>>
>;

/** Every event name a display block accepts; each block further narrows this to its own binding. */
export const DISPLAY_EVENT_NAMES: readonly DisplaySemanticEventName[] = Object.freeze([
  "refresh",
  "row_clicked",
  "row_action",
  "selection_changed",
  "filter_changed",
  "table_records_requested",
  "pivot_requested",
  "pivot_view_changed",
  "pivot_drilled",
  "group_changed",
  "group_page_changed",
  "group_requested",
  "group_opened",
  "grid_view_requested",
  "search_changed",
  "sort_changed",
  "columns_changed",
  "page_changed",
  "bulk_action",
  "selection_scope_changed",
  "export_requested",
  "export_cancelled",
  "range_summary_requested",
  "batch_edit_requested",
  "inline_edit",
  "row_edit",
  "card_moved",
  "card_added",
  "row_expanded",
]);
