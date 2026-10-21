import { z } from "zod";
import { recordIdSchema } from "../catalogue/identifiers";
import {
  RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS,
  recordsTableStatusBarOperations,
} from "../definition/application-composition/records-table-features/spreadsheet";
import { recordsSelectionMaximumIds } from "./records-selection";

const readTokenSchema = z
  .string()
  .min(1)
  .max(65_536)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The totals of a selected range of one Records table page. `token` is the sealed descriptor of the
 * read the rows were shown from and `page` the position of that page in the address; the server
 * reads the page again under the person's current access and keeps only `recordIds`, which must all
 * be on it. `fieldIds` name columns the status bar offers; the server decides which it totals. The
 * browser never sends a value, an operation or a permission.
 */
export const recordsRangeSummaryRequestSchema = z
  .object({
    pageKey: z.string().min(1).max(200),
    placementId: z.string().min(1).max(200),
    token: readTokenSchema,
    page: z
      .object({
        pageDirection: z.enum(["forward", "backward"]),
        continuationToken: readTokenSchema.optional(),
      })
      .strict()
      .optional(),
    recordIds: z.array(recordIdSchema).min(1).max(recordsSelectionMaximumIds),
    fieldIds: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS),
  })
  .strict();
export type RecordsRangeSummaryRequest = z.infer<typeof recordsRangeSummaryRequestSchema>;

export const recordsRangeSummaryTotalSchema = z.discriminatedUnion("kind", [
  /** The total, ready to show: formatted by the server, never computed in the browser. */
  z.object({ kind: z.literal("value"), text: z.string().min(1).max(200) }).strict(),
  /** No selected cell held a value. */
  z.object({ kind: z.literal("none") }).strict(),
  /** A money total over more than one currency is refused, never converted. */
  z.object({ kind: z.literal("mixed_currency") }).strict(),
]);

export type RecordsRangeSummaryTotal = z.infer<typeof recordsRangeSummaryTotalSchema>;

export const recordsRangeSummaryFieldSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("totals"),
      fieldId: z.string().min(1).max(200),
      totals: z
        .array(
          z
            .object({
              operation: z.enum(recordsTableStatusBarOperations),
              total: recordsRangeSummaryTotalSchema,
            })
            .strict(),
        )
        .max(recordsTableStatusBarOperations.length),
    })
    .strict(),
  /** The person may not read this field on every selected record: nothing is totalled. */
  z.object({ state: z.literal("withheld"), fieldId: z.string().min(1).max(200) }).strict(),
]);

export type RecordsRangeSummaryField = z.infer<typeof recordsRangeSummaryFieldSchema>;

export const recordsRangeSummaryResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("summarised"),
      fields: z.array(recordsRangeSummaryFieldSchema).max(RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS),
    })
    .strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export type RecordsRangeSummaryResult = z.infer<typeof recordsRangeSummaryResultSchema>;
