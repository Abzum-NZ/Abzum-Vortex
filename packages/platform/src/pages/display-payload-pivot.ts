import { z } from "zod";
import { displayScalarCellSchema, displayTextSchema } from "./display-payload-parts";

/*
 * One page of a Records table's pivot. The server types the page it reads with these schemas and
 * the pivot panel parses the reply with the same ones. A refusal carries a business sentence and
 * nothing else; an error carries nothing, so the panel cannot show values the read did not
 * authorise. The cause stays in the log.
 */

const wholeCountSchema = z.number().int().nonnegative();

/** The filter a click on a row or column heading applies to the ordinary grid, in address spelling. */
export const pivotDrillSchema = z
  .object({ fieldId: displayTextSchema, filter: displayTextSchema })
  .strict()
  .readonly();
export type PivotDrill = z.input<typeof pivotDrillSchema>;

const pivotAxisShape = {
  /** The canonical value text the server keys it by (a choice value or a bucket start). */
  key: displayTextSchema,
  label: displayTextSchema,
  drill: pivotDrillSchema.exactOptional(),
};

/** One row or column heading of a pivot. */
export const pivotAxisValueSchema = z.object(pivotAxisShape).strict().readonly();
export type PivotAxisValue = z.input<typeof pivotAxisValueSchema>;

/** One cell value a pivot shows: the same closed values a summary shows. */
export type PivotCell = z.input<typeof displayScalarCellSchema>;

/** One row of a pivot: its heading, its records and one cell per column. */
export const pivotRowSchema = z
  .object({
    ...pivotAxisShape,
    /** Records in this row. */
    count: wholeCountSchema,
    /** One entry per column, null where the row holds no record of that column. */
    cells: z.array(displayScalarCellSchema.nullable()).readonly(),
    total: displayScalarCellSchema.exactOptional(),
  })
  .strict()
  .readonly();
export type PivotRow = z.input<typeof pivotRowSchema>;

/** One page of a pivot, or why there is none. */
export const pivotResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      rowLabel: displayTextSchema,
      columnLabel: displayTextSchema,
      measureLabel: displayTextSchema,
      columns: z.array(pivotAxisValueSchema).readonly(),
      rows: z.array(pivotRowSchema).readonly(),
      /** Aligned with `columns`; present when the table shows totals. */
      columnTotals: z.array(displayScalarCellSchema).readonly().exactOptional(),
      grandTotal: displayScalarCellSchema.exactOptional(),
      totalRecords: wholeCountSchema,
      rowGroupCount: wholeCountSchema,
      /** Opaque position of the next page of rows; absent on the last page. */
      nextCursor: displayTextSchema.exactOptional(),
    })
    .strict()
    .readonly()
    .superRefine((pivot, context) => {
      pivot.rows.forEach((row, index) => {
        if (row.cells.length !== pivot.columns.length)
          context.addIssue({
            code: "custom",
            path: ["rows", index, "cells"],
            message: "A pivot row has a cell per column",
          });
      });
      if (pivot.columnTotals !== undefined && pivot.columnTotals.length !== pivot.columns.length)
        context.addIssue({
          code: "custom",
          path: ["columnTotals"],
          message: "A pivot has a total per column",
        });
    }),
  z
    .object({ status: z.literal("empty") })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("refused"), message: displayTextSchema })
    .strict()
    .readonly(),
  z
    .object({ status: z.literal("error") })
    .strict()
    .readonly(),
]);
export type PivotResult = z.input<typeof pivotResultSchema>;
export type PivotPage = Omit<
  Extract<z.output<typeof pivotResultSchema>, { status: "ready" }>,
  "status"
>;
