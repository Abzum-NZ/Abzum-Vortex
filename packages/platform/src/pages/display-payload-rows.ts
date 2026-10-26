import { z } from "zod";
import { jsonValueSchema } from "../catalogue/common";
import { revisionSchema } from "../catalogue/identifiers";
import {
  displayFieldKeySchema,
  displayScalarCellSchema,
  displayTextSchema,
  refineUniqueKeys,
} from "./display-payload-parts";

/**
 * The per-row capabilities the Query engine decided for the viewer: the fields it may change on
 * this row and the record actions it may take. They only hide controls; the server re-checks
 * every change and action.
 */
export const displayRowCapabilitiesSchema = z
  .object({
    changeableFieldIds: z.array(displayFieldKeySchema).readonly(),
    actions: z.array(z.enum(["update", "delete", "restore"])).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((capabilities, context) => {
    refineUniqueKeys(
      capabilities.changeableFieldIds,
      (fieldId) => fieldId.toLowerCase(),
      context,
      "Each changeable field is reported once",
      ["changeableFieldIds"],
    );
    refineUniqueKeys(
      capabilities.actions,
      (action) => action,
      context,
      "Each row action is reported once",
      ["actions"],
    );
  });

/**
 * A row's formatting: the style key of the whole row, the style key of each formatted cell and
 * each numeric column's position in the page's range, from 0 to 1. Only style keys travel, so a
 * payload can never carry a colour or markup of its own.
 */
export const displayRowFormatSchema = z
  .object({
    row: displayTextSchema.exactOptional(),
    cells: z.record(displayFieldKeySchema, displayTextSchema).readonly().exactOptional(),
    measures: z.record(displayFieldKeySchema, z.number().min(0).max(1)).readonly().exactOptional(),
  })
  .strict()
  .readonly();

/**
 * One permission-projected row addressed by its stable record identity. A Records table row also
 * carries the record revision an inline edit sends and its per-row capabilities; either is absent
 * when the payload does not carry it, and is never inferred.
 */
export const displayRowSchema = z
  .object({
    recordId: displayTextSchema,
    revision: revisionSchema.exactOptional(),
    capabilities: displayRowCapabilitiesSchema.exactOptional(),
    /** The record type title projected under the viewer's current access. */
    title: z
      .object({ fieldId: displayFieldKeySchema, value: displayScalarCellSchema })
      .strict()
      .readonly()
      .exactOptional(),
    /**
     * The stored value of each field the viewer may edit on this row (null when empty), as the
     * field's own contract spells it. An editor starts from this, never from a displayed cell.
     */
    edit: z.record(displayFieldKeySchema, jsonValueSchema).readonly().exactOptional(),
    cells: z.record(displayFieldKeySchema, displayScalarCellSchema).readonly(),
    /** The style keys and measures the table's formatting gives the row, decided on the server. */
    format: displayRowFormatSchema.exactOptional(),
    /**
     * A tree row the viewer may read a matching child of, decided on the server; "unknown" when the
     * server stopped before deciding, so the child level is read when the row is opened.
     */
    hasChildren: z.union([z.literal(true), z.literal("unknown")]).exactOptional(),
    /** The exact text of each readable number and money cell, for the range copy. */
    exact: z.record(displayFieldKeySchema, displayTextSchema).readonly().exactOptional(),
  })
  .strict()
  .readonly();
export type DisplayRow = z.output<typeof displayRowSchema>;

/** Projected rows, each record once. */
export const displayRowsSchema = z
  .array(displayRowSchema)
  .readonly()
  .superRefine((rows, context) =>
    refineUniqueKeys(rows, (row) => row.recordId, context, "Each projected record appears once"),
  );
