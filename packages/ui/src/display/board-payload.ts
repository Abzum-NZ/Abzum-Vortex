import { boardPayloadSchema } from "@vortex/platform/schema";
import { projectedValuesParser } from "./projected-data";

/**
 * The strict bounded payload a query-bound board renders, parsed with the schema the server types
 * it with.
 */
export const parseBoardPayload = projectedValuesParser(
  boardPayloadSchema,
  "Projected board values are invalid",
);
