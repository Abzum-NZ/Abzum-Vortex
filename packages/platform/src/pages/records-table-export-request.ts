import { z } from "zod";
import { platformIdSchema } from "../catalogue/identifiers";
import { recordsTableExportFormats } from "../definition/application-composition/records-table-features/export";
import { recordsSelectionSchema } from "./records-selection";

const readTokenSchema = z
  .string()
  .min(1)
  .max(65_536)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * One export of a Records table. `selection` is what the person chose, exactly as every bulk
 * command takes it. `token` is the sealed descriptor of the read the rows were shown from: it
 * carries the resolved query inputs, so a selection of shown rows (`ids`) needs it; a `matching`
 * selection carries its own and must not name another. The columns, their order and the viewer's
 * saved view are never sent: the server decides them from the installed placement and the
 * person's current layout. `viewId` names the saved view the grid showed, a candidate only.
 */
export const recordsTableExportRequestSchema = z
  .object({
    pageKey: z.string().min(1).max(200),
    placementId: z.string().min(1).max(200),
    format: z.enum(recordsTableExportFormats),
    selection: recordsSelectionSchema,
    token: readTokenSchema.optional(),
    viewId: platformIdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.selection.kind === "ids" && request.token === undefined)
      context.addIssue({
        code: "custom",
        path: ["token"],
        message: "Rows chosen on a page need the page's read",
      });
    if (request.selection.kind === "matching" && request.token !== undefined)
      context.addIssue({
        code: "custom",
        path: ["token"],
        message: "Every matching record carries its own read",
      });
  });
export type RecordsTableExportRequest = z.infer<typeof recordsTableExportRequestSchema>;

/**
 * Why the server refused an export before sending a file, in the closed words the person's
 * message is chosen from. The cause behind a refusal stays in the server log.
 */
export const recordsTableExportRefusalReasons = [
  /** Export is not on, not permitted now, or the request does not fit this table. */
  "not_available",
  /** This format is known, but the installed table does not offer it. */
  "format_not_authored",
  /** The selection holds more records than the table's row limit. */
  "too_many",
  /** The selection changed since it was made (a new release, or an expired read). */
  "changed",
] as const;
export type RecordsTableExportRefusalReason = (typeof recordsTableExportRefusalReasons)[number];

export const recordsTableExportRefusalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("refused"),
      reason: z.enum(recordsTableExportRefusalReasons),
      /** The table's row limit, when the refusal is about it. */
      limit: z.number().int().positive().optional(),
      /** The number of records the selection holds, when it is known. */
      count: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
export type RecordsTableExportRefusal = z.infer<typeof recordsTableExportRefusalSchema>;
