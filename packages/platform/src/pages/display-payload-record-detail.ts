import { z } from "zod";
import {
  displayDetailFieldsSchema,
  displayScalarCellSchema,
  displayTextSchema,
} from "./display-payload-parts";

/**
 * The ready values a record-detail block renders: the record's identity, its declared fields in
 * declared order and, when declared, its heading value.
 */
export const recordDetailPayloadSchema = z
  .object({
    kind: z.literal("record_detail"),
    recordId: displayTextSchema,
    fields: displayDetailFieldsSchema,
    heading: displayScalarCellSchema.exactOptional(),
  })
  .strict()
  .readonly();
export type RecordDetailPayload = z.output<typeof recordDetailPayloadSchema>;
