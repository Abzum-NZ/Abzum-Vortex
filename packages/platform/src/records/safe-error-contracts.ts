import { z } from "zod";
import { correlationIdSchema } from "../catalogue/common";

const safeOperationErrorCatalogue = Object.freeze({
  invalid_request: "errors.invalid_request",
  not_found: "errors.not_found",
  operation_refused: "errors.operation_refused",
  conflict: "errors.conflict",
  rate_limited: "errors.rate_limited",
  temporarily_unavailable: "errors.temporarily_unavailable",
  operation_failed: "errors.operation_failed",
} as const);

const safeErrorVariant = <Code extends keyof typeof safeOperationErrorCatalogue>(code: Code) =>
  z
    .object({
      code: z.literal(code),
      messageKey: z.literal(safeOperationErrorCatalogue[code]),
      correlationId: correlationIdSchema,
    })
    .strict();

export const safeErrorResponseSchema = z.discriminatedUnion("code", [
  safeErrorVariant("invalid_request"),
  safeErrorVariant("not_found"),
  safeErrorVariant("operation_refused").extend({
    reason: z
      .object({ code: z.string().min(1), message: z.string().min(1) })
      .strict()
      .optional(),
  }),
  safeErrorVariant("conflict"),
  safeErrorVariant("rate_limited"),
  safeErrorVariant("temporarily_unavailable"),
  safeErrorVariant("operation_failed"),
]);
