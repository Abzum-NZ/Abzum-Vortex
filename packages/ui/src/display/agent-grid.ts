"use client";

import { useContext, useEffect, useRef } from "react";
import { recordsTableInlineEditEvent, type JsonValue } from "@vortex/platform/schema";
import { FlowRuntimeStateContext } from "../flow-runtime/flow-runtime-state-context";
import type { AgentGridEditResult } from "../agent/page-agent-controls";
import type { DisplayEventHandlers } from "./display-events";
import type { DisplayRow, DisplayTablePayload } from "./projected-data";

type GridState = Readonly<{
  rows: readonly DisplayRow[];
  columns: readonly Readonly<{ key: string; label: string }>[];
  features: DisplayTablePayload["features"];
  events: DisplayEventHandlers | undefined;
  selectable: boolean;
  selectedRecordIds: readonly string[];
  activateRow: ((recordId: string) => unknown) | undefined;
}>;

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** A cell the viewer may edit in place on this row, as the grid's own editor decides it. */
const editable = (state: GridState, row: DisplayRow, field: string): boolean =>
  state.features?.inlineEdit?.fields.some((candidate) => same(candidate.field, field)) === true &&
  state.events?.[recordsTableInlineEditEvent] !== undefined &&
  row.revision !== undefined &&
  row.edit !== undefined &&
  Object.keys(row.edit).some((key) => same(key, field)) &&
  row.capabilities !== undefined &&
  row.capabilities.actions.includes("update") &&
  row.capabilities.changeableFieldIds.some((fieldId) => same(fieldId, field));

const editResult = (answer: unknown): AgentGridEditResult => {
  if (typeof answer === "object" && answer !== null && "kind" in answer) {
    if (answer.kind === "saved") return { kind: "saved" };
    if ("message" in answer && typeof answer.message === "string")
      return { kind: "refused", message: answer.message };
  }
  return { kind: "refused", message: "That is not available right now." };
};

/**
 * Registers a records grid with the page's agent: the rows on its page, its columns, and its row
 * open, cell edit, selection and bulk gestures, each the same event the person's gesture emits.
 */
export function useAgentGrid(placementId: string, label: string, state: GridState): void {
  const runtimeState = useContext(FlowRuntimeStateContext);
  const current = useRef(state);
  current.current = state;
  useEffect(
    () =>
      runtimeState?.agent.register({
        kind: "grid",
        id: placementId,
        label,
        rows: () =>
          current.current.rows.map((row) => ({
            record: row.recordId,
            cells: row.cells as Readonly<Record<string, JsonValue>>,
            selected: current.current.selectedRecordIds.includes(row.recordId),
          })),
        columns: () =>
          current.current.columns.map((column) => ({
            field: column.key,
            label: column.label,
            editable: current.current.rows.some((row) =>
              editable(current.current, row, column.key),
            ),
          })),
        bulkActions: () =>
          current.current.selectable && current.current.events?.bulk_action !== undefined
            ? (current.current.features?.bulkActions ?? []).map((action) => ({
                action: action.action,
                label: action.label,
              }))
            : [],
        open:
          state.activateRow === undefined
            ? undefined
            : (record) => current.current.activateRow?.(record),
        edit: async (record, field, value) => {
          const grid = current.current;
          const row = grid.rows.find((candidate) => same(candidate.recordId, record));
          const handler = grid.events?.[recordsTableInlineEditEvent];
          const eventId = grid.features?.inlineEdit?.eventId;
          if (
            row === undefined ||
            handler === undefined ||
            eventId === undefined ||
            row.revision === undefined ||
            !editable(grid, row, field)
          )
            return { kind: "refused", message: "That cell cannot be edited." };
          return editResult(
            await handler({
              event: recordsTableInlineEditEvent,
              eventId,
              recordId: row.recordId,
              revision: row.revision,
              field,
              value,
              commandId: crypto.randomUUID(),
            }),
          );
        },
        select: (records, selected) => {
          const grid = current.current;
          const handler = grid.events?.selection_changed;
          if (!grid.selectable || handler === undefined) return false;
          for (const record of records) {
            const row = grid.rows.find((candidate) => same(candidate.recordId, record));
            if (row?.revision === undefined) return false;
            void handler({
              event: "selection_changed",
              recordId: row.recordId,
              revision: row.revision,
              selected,
            });
          }
          return true;
        },
        bulk: (action) => current.current.events?.bulk_action?.({ event: "bulk_action", action }),
      }),
    [label, placementId, runtimeState, state.activateRow === undefined],
  );
}
