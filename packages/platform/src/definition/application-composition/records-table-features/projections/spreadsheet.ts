import { z } from "zod";
import { projectionFieldKeySchema as fieldKeySchema } from "./field-key";
import {
  RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS,
  recordsTableStatusBarOperations,
  recordsTableSpreadsheetFeature,
} from "../spreadsheet";

const onlyTrue = z.literal(true);
const spreadsheetSchema = z
  .object({
    rangeSelect: z.boolean(),
    find: z.boolean(),
    /** Paste, fill down and undo of batches; each is present only when usable now. */
    paste: onlyTrue.optional(),
    fill: onlyTrue.optional(),
    undo: onlyTrue.optional(),
    /**
     * The status bar of a selected range: the configured fields (every one is shown, a field the
     * viewer cannot read as "Not available") and the totals. Absent while the status bar is off.
     */
    statusBar: z
      .object({
        fields: z
          .array(fieldKeySchema)
          .min(1)
          .max(RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS)
          .readonly(),
        operations: z.array(z.enum(recordsTableStatusBarOperations)).min(1).readonly(),
      })
      .strict()
      .readonly()
      .refine(
        (bar) =>
          new Set(bar.fields).size === bar.fields.length &&
          new Set(bar.operations).size === bar.operations.length,
        "The status bar names each field and total once",
      )
      .optional(),
  })
  .strict()
  .readonly()
  .refine((controls) => controls.rangeSelect || controls.find, {
    message: "Spreadsheet controls need an enabled control",
  })
  .refine(
    (controls) =>
      !(controls.undo === true && controls.paste !== true && controls.fill !== true) &&
      !((controls.paste === true || controls.fill === true) && !controls.rangeSelect),
    { message: "Paste, fill and undo need a range and an edit" },
  )
  .refine((controls) => controls.statusBar === undefined || controls.rangeSelect, {
    message: "The status bar needs a range",
  });

export const spreadsheetProjectionSchema = spreadsheetSchema;

/** This feature's viewer projection: its definition's property and the strict schema under it. */
export const spreadsheetProjection = {
  property: recordsTableSpreadsheetFeature.property,
  schema: spreadsheetProjectionSchema,
} as const;
