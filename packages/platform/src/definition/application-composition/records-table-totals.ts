import { z } from "zod";
import { fieldIdSchema } from "../../catalogue/identifiers";

/** The operations shared by authored measures, summary requests and projected totals. */
export const recordsTableAggregateOperations = [
  "count",
  "sum",
  "average",
  "minimum",
  "maximum",
  "distinct_count",
] as const;
export type RecordsTableAggregateOperation = (typeof recordsTableAggregateOperations)[number];
export const recordsTableAggregateLabels: Readonly<Record<RecordsTableAggregateOperation, string>> =
  {
    count: "Count",
    sum: "Sum",
    average: "Average",
    minimum: "Minimum",
    maximum: "Maximum",
    distinct_count: "Distinct count",
  };

/** Only formatted, permission-checked values cross the renderer boundary. */
export const recordsTableTotalSchema = z
  .object({
    fieldId: fieldIdSchema,
    operation: z.enum(recordsTableAggregateOperations),
    state: z.enum(["value", "empty", "withheld", "mixed_currency", "unavailable"]),
    text: z.string().optional(),
  })
  .strict()
  .superRefine((total, context) => {
    if ((total.state === "value") !== (total.text !== undefined))
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Only a readable total carries a value",
      });
  });
export const recordsTableTotalsSchema = z
  .array(recordsTableTotalSchema)
  .max(6)
  .refine(
    (totals) =>
      new Set(totals.map((total) => `${total.fieldId.toLowerCase()}:${total.operation}`)).size ===
      totals.length,
    { message: "Each measure is named once" },
  );
export type RecordsTableTotal = z.infer<typeof recordsTableTotalSchema>;
