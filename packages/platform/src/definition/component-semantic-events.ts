import { z } from "zod";
import { recordsTableInlineEditEvent } from "./application-composition/records-table-features/inline-edit";
import { recordsTableRowEditEvent } from "./application-composition/records-table-features/row-edit";

/** The semantic events a block can raise; a flow binding and a block release name them alike. */
export const componentSemanticEventKindSchema = z.enum([
  "action",
  "row_clicked",
  "row_action",
  "bulk_action",
  recordsTableInlineEditEvent,
  recordsTableRowEditEvent,
  "card_moved",
  "card_added",
  "load",
  "refresh",
  "filter_changed",
  "search_changed",
  "sort_changed",
  "columns_changed",
  "row_expanded",
  "page_changed",
  "selection_changed",
  "field_changed",
  "form_ready",
  "form_reset",
  "form_submit",
  "tab_changed",
  "guided_step_changed",
]);

export type ComponentSemanticEventKind = z.infer<typeof componentSemanticEventKindSchema>;
