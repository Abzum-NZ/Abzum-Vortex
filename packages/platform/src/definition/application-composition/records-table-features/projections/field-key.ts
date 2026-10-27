import { z } from "zod";
import { builderKeySchema, fieldIdSchema } from "../../../../catalogue/identifiers";

/** A field key as the table's columns spell it: an authored key or a field identity. */
export const projectionFieldKeySchema = z
  .string()
  .refine(
    (value) => builderKeySchema.safeParse(value).success || fieldIdSchema.safeParse(value).success,
    "A field is named by its key or identity",
  );
