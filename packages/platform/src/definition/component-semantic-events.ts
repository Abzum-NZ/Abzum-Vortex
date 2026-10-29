import { z } from "zod";
import { recordsTableInlineEditEvent } from "./application-composition/records-table-features/inline-edit";
import { recordsTableRowEditEvent } from "./application-composition/records-table-features/row-edit";
import type { FlowFormula } from "../workflows/flow-values";
import { flowMaximumServerSeconds } from "../workflows/flow-limits";

/** The semantic events a block can raise; a flow binding and a block release name them alike. */
export const componentSemanticEventKindSchema = z.enum([
  "action",
  "row_clicked",
  "row_action",
  "bulk_action",
  recordsTableInlineEditEvent,
  recordsTableRowEditEvent,
  "batch_edit",
  "card_moved",
  "card_added",
  "load",
  "refresh",
  "record_loaded",
  "filter_changed",
  "search_changed",
  "sort_changed",
  "columns_changed",
  "row_expanded",
  "page_changed",
  "selection_changed",
  "field_changed",
  "field_focus_lost",
  "options_requested",
  "form_ready",
  "form_reset",
  "form_submit",
  "form_cancel",
  "tab_changed",
  "guided_step_changed",
]);

export type ComponentSemanticEventKind = z.infer<typeof componentSemanticEventKindSchema>;

/**
 * How a binding treats a second start while its flow runs: ignore it (no double submit), let the
 * latest start win (the earlier run's pending request is cancelled and a late reply dropped), or
 * queue it behind the running one.
 */
export const flowBindingConcurrencySchema = z.enum([
  "ignore_while_running",
  "latest_wins",
  "queue",
]);
export type FlowBindingConcurrency = z.infer<typeof flowBindingConcurrencySchema>;

/** While an exclusive binding's flow runs, nothing else starts on its form or its page. */
export const flowBindingExclusiveScopeSchema = z.enum(["none", "form", "page"]);
export type FlowBindingExclusiveScope = z.infer<typeof flowBindingExclusiveScopeSchema>;

/** The longest a bound flow may run before the page gives up waiting for it. */
export const flowBindingMaximumTimeoutMs = flowMaximumServerSeconds * 1_000;

/**
 * The settings every flow binding carries, written explicitly into the definition: an optional
 * condition over page values that must hold for the event to start the flow, a debounce, the
 * concurrency policy, the exclusive scope and a timeout (required for an exclusive binding). The
 * binding contract (`application-flow-bindings.ts`) validates them.
 */
export type FlowBindingSettings = {
  condition: FlowFormula | null;
  debounceMs: number;
  concurrency: FlowBindingConcurrency;
  exclusive: FlowBindingExclusiveScope;
  timeoutMs: number | null;
};
type EventDefaults = Readonly<FlowBindingSettings>;

const once = (exclusive: FlowBindingExclusiveScope = "none"): EventDefaults => ({
  condition: null,
  debounceMs: 0,
  concurrency: "ignore_while_running",
  exclusive,
  timeoutMs: exclusive === "none" ? null : flowBindingMaximumTimeoutMs,
});
const latest = (debounceMs = 0): EventDefaults => ({
  condition: null,
  debounceMs,
  concurrency: "latest_wins",
  exclusive: "none",
  timeoutMs: null,
});
const queued: EventDefaults = {
  condition: null,
  debounceMs: 0,
  concurrency: "queue",
  exclusive: "none",
  timeoutMs: null,
};

/**
 * Each event's default binding settings (Studio flows design §1 and §7): buttons, opens and form
 * events ignore a start while their flow runs, a form submit and a bulk action are exclusive to
 * their form or page within the server's segment time limit, field changes and searches let the
 * latest start win after a short debounce, and edits queue so they keep their order. A new binding
 * is written with these values; the page runner never fills a missing one.
 */
export const componentEventBindingDefaults: Readonly<
  Record<ComponentSemanticEventKind, EventDefaults>
> = Object.freeze({
  action: once(),
  row_clicked: once(),
  row_action: once(),
  bulk_action: once("page"),
  [recordsTableInlineEditEvent]: queued,
  [recordsTableRowEditEvent]: queued,
  batch_edit: queued,
  card_moved: queued,
  card_added: once(),
  load: latest(),
  refresh: latest(),
  record_loaded: latest(),
  filter_changed: latest(),
  search_changed: latest(250),
  sort_changed: latest(),
  columns_changed: latest(),
  row_expanded: latest(),
  page_changed: latest(),
  selection_changed: latest(),
  field_changed: latest(250),
  field_focus_lost: latest(),
  options_requested: latest(250),
  form_ready: once(),
  form_reset: once(),
  form_submit: once("form"),
  form_cancel: once(),
  tab_changed: latest(),
  guided_step_changed: once(),
} satisfies Record<ComponentSemanticEventKind, EventDefaults>);

/** A fresh copy of an event's default binding settings, for a new binding. */
export const defaultFlowBindingSettings = (
  event: ComponentSemanticEventKind,
): FlowBindingSettings => ({
  ...componentEventBindingDefaults[event],
});
