import type { JsonValue } from "@vortex/platform/schema";

/**
 * What a rendered control tells an agent about itself and how the agent uses it. Each control
 * registers its handle while it is mounted, so the tools an agent sees are the page model as the
 * person sees it now, and using a handle runs exactly what the person's gesture runs.
 */

/** A button: activating it is the person's click, refused while the button is not usable. */
export type AgentButton = Readonly<{
  kind: "button";
  id: string;
  label: string;
  /** The form whose one submit or reset path the button takes, when it is a Submit or Reset button. */
  formId: string | undefined;
  /** Why the button cannot be used now; absent when it can. */
  refusal: () => "hidden" | "disabled" | undefined;
  /** The click: what the button's own click runs. */
  activate: () => unknown;
}>;

type AgentGridRow = Readonly<{
  record: string;
  cells: Readonly<Record<string, JsonValue>>;
  selected: boolean;
  /** The row actions the person may run on this row now, by action key. */
  actions: readonly string[];
}>;

export type AgentGridEditResult =
  Readonly<{ kind: "saved" }> | Readonly<{ kind: "refused"; message: string }>;

/** A records grid: the rows on its page, and its own row, cell, selection and bulk gestures. */
export type AgentGrid = Readonly<{
  kind: "grid";
  id: string;
  label: string;
  rows: () => readonly AgentGridRow[];
  /** The columns shown, and whether the viewer may edit their cells in place. */
  columns: () => readonly Readonly<{ field: string; label: string; editable: boolean }>[];
  /** The bulk actions offered over the selection now. */
  bulkActions: () => readonly Readonly<{ action: string; label: string }>[];
  /** The actions the grid offers on its rows (each row says which it may run now). */
  rowActions: () => readonly Readonly<{ action: string; label: string }>[];
  /** Runs one row action the way its row command does; a refusal names why. */
  act: (record: string, action: string) => Readonly<{ refused: string }> | Promise<unknown>;
  /** Opens a row the way a click on it does; undefined when the grid opens no rows. */
  open: ((record: string) => unknown) | undefined;
  /** Commits one cell the way the person's in-place edit does. */
  edit: (record: string, field: string, value: JsonValue) => Promise<AgentGridEditResult>;
  /** Ticks or unticks rows the way their checkboxes do; false when the grid selects none. */
  select: (records: readonly string[], selected: boolean) => boolean;
  /** Runs a bulk action over the selection the way its menu item does. */
  bulk: (action: string) => unknown;
}>;

export type AgentControl = AgentButton | AgentGrid;
