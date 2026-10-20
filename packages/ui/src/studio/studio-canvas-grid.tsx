"use client";

import { createContext, useContext } from "react";
import {
  canonicalJson,
  isRecord,
  readRecordsTableContract,
  type GridLayout,
  type GridLayoutCommitResult,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import type { DisplayEventHandlers } from "../display/projected-data";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/** A committed canvas arrangement in the definition's ordinary field-reference spelling. */
export type StudioCanvasGridArrangement = Readonly<{
  placementAlias: string;
  key: string;
  state: Group;
}>;

/** A query or authored layout change invalidates an earlier interactive arrangement. */
export const studioCanvasGridKey = (query: unknown, columns: unknown, density: unknown): string =>
  canonicalJson([query ?? null, columns ?? null, density ?? null]);

export const StudioCanvasGridContext = createContext<
  ((arrangement: StudioCanvasGridArrangement) => void) | undefined
>(undefined);

/** The canvas uses the grid's normal layout event; no personal preference is written. */
export function useStudioCanvasGridEvents(
  props: Readonly<Record<string, unknown>>,
  compiled: Readonly<Record<string, unknown>> | undefined,
): DisplayEventHandlers | undefined {
  const arrange = useContext(StudioCanvasGridContext);
  if (arrange === undefined || compiled === undefined) return undefined;
  const contract = readRecordsTableContract(
    compiled as Parameters<typeof readRecordsTableContract>[0],
  );
  if (contract === undefined || !contract.features.savedViews.enabled) return undefined;
  const sourceColumns = props.columns;
  if (!Array.isArray(sourceColumns) || sourceColumns.length !== contract.columns.length)
    throw new Error("STUDIO_CANVAS_GRID_COLUMNS_MISMATCH");
  const fields = new Map(
    contract.columns.map((column, index) => {
      const source = sourceColumns[index];
      if (!isRecord(source) || typeof source.field !== "string")
        throw new Error("STUDIO_CANVAS_GRID_FIELD_MISSING");
      return [column.field.toLowerCase(), source.field] as const;
    }),
  );
  const vortex = isRecord(props.vortex) ? props.vortex : {};
  return {
    columns_changed: async (event): Promise<GridLayoutCommitResult> => {
      if (event.event !== "columns_changed") return { outcome: "unavailable" };
      // Reset returns to the authored columns and density, through this same event.
      const columns: GridLayout["columns"] =
        event.layout?.columns ??
        contract.columns.map((column) => ({
          fieldId: column.field.toLowerCase(),
          visible: column.visible,
          pin: column.pin,
        }));
      arrange({
        placementAlias: String(props.id),
        key: studioCanvasGridKey(vortex.query, props.columns, props.density),
        state: {
          kind: "group",
          properties: {
            columns: {
              kind: "list",
              items: columns.map((column): Group => {
                const field = fields.get(column.fieldId);
                if (field === undefined) throw new Error("STUDIO_CANVAS_GRID_FIELD_UNMAPPED");
                return {
                  kind: "group",
                  properties: {
                    field: { kind: "field_reference", field },
                    visible: { kind: "boolean", value: column.visible },
                    pin: { kind: "choice", value: column.pin },
                    ...("width" in column && column.width !== undefined
                      ? { width: { kind: "number" as const, value: column.width } }
                      : {}),
                  },
                };
              }),
            },
            density: { kind: "choice", value: event.layout?.density ?? contract.density },
          },
        },
      });
      return { outcome: "previewed" };
    },
  };
}
