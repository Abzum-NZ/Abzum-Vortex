import { z } from "zod";
import { builderKeySchema, sourceQualifiedRecordTypeSchema } from "../catalogue/identifiers";
import { labelSchema } from "../catalogue/common";
import { sourceProvenanceTarget, sourceProvenanceUnchanged } from "./definition-source-common";
import { compileTextInputPattern } from "../pages/text-input-pattern";
import { sourceExactDecimalTextSchema } from "../records/module-field-values";
import { exactRangeValid, formattedTextAllowedBlockSchema } from "./module-source-fields";

// ---------------------------------------------------------------------------
// Shared action-input contract. Application source contracts import this
// directly; it deliberately excludes the exact decimal_number/money input
// types Module actions add below, so its shape stays fixed across Modules.
// ---------------------------------------------------------------------------

// A text pattern must compile under the shared RE2 contract and always travels
// with a maximum length. Module and application action and query inputs share it.
const refineTextInputPattern = (
  validation: { maximum_length?: number | undefined; pattern?: string | undefined } | undefined,
  context: z.RefinementCtx,
): void => {
  if (validation?.pattern === undefined) return;
  if (validation.maximum_length === undefined)
    context.addIssue({
      code: "custom",
      path: ["validation", "maximum_length"],
      message: "Maximum length is required when a pattern is set",
    });
  if (compileTextInputPattern(validation.pattern) === undefined)
    context.addIssue({
      code: "custom",
      path: ["validation", "pattern"],
      message:
        "Enter a valid RE2 pattern (maximum 500 characters; backreferences and lookaround are unsupported)",
    });
};

// ---------------------------------------------------------------------------
// Module action inputs, including exact decimal_number and money inputs.
// ---------------------------------------------------------------------------

const moduleSourceActionInputBase = {
  key: sourceProvenanceUnchanged(builderKeySchema),
  label: sourceProvenanceUnchanged(labelSchema),
  required: sourceProvenanceUnchanged(z.boolean()),
};
const moduleSourceExactActionInputValidationSchema = z
  .object({
    minimum: sourceProvenanceTarget(sourceExactDecimalTextSchema.optional(), ["minimum"]),
    maximum: sourceProvenanceTarget(sourceExactDecimalTextSchema.optional(), ["maximum"]),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined ||
      value.maximum === undefined ||
      exactRangeValid(value.minimum, value.maximum),
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );

export const moduleSourceActionInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("text"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              minimum_length: sourceProvenanceUnchanged(z.number().int().min(0).optional()),
              maximum_length: sourceProvenanceUnchanged(z.number().int().positive().optional()),
              pattern: sourceProvenanceUnchanged(z.string().min(1).max(500).optional()),
            })
            .strict()
            .optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("formatted_text"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              allowed_blocks: sourceProvenanceUnchanged(
                z.array(formattedTextAllowedBlockSchema).min(1),
              ),
              maximum_length: sourceProvenanceUnchanged(z.number().int().positive().optional()),
            })
            .strict()
            .optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("number"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              minimum: sourceProvenanceTarget(z.number().finite().optional(), ["minimum"]),
              maximum: sourceProvenanceTarget(z.number().finite().optional(), ["maximum"]),
            })
            .strict()
            .optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("decimal_number"), ["type"]),
        validation: sourceProvenanceUnchanged(
          moduleSourceExactActionInputValidationSchema.optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("money"), ["type"]),
        validation: sourceProvenanceUnchanged(
          moduleSourceExactActionInputValidationSchema.optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("boolean"), ["type"]),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("date"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              earliest: sourceProvenanceUnchanged(z.iso.date().optional()),
              latest: sourceProvenanceUnchanged(z.iso.date().optional()),
            })
            .strict()
            .optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("date_time"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              earliest: sourceProvenanceUnchanged(z.iso.datetime({ offset: true }).optional()),
              latest: sourceProvenanceUnchanged(z.iso.datetime({ offset: true }).optional()),
            })
            .strict()
            .optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("record_reference"), ["type"]),
        record_types: sourceProvenanceUnchanged(
          z
            .array(sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordTypes/#/**"]))
            .min(1)
            .max(20),
        ),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.type === "text" &&
      value.validation?.minimum_length !== undefined &&
      value.validation.maximum_length !== undefined &&
      value.validation.minimum_length > value.validation.maximum_length
    )
      context.addIssue({
        code: "custom",
        path: ["validation", "maximum_length"],
        message: "Maximum length cannot be below minimum length",
      });
    if (value.type === "text") refineTextInputPattern(value.validation, context);
    if (
      value.type === "number" &&
      value.validation?.minimum !== undefined &&
      value.validation.maximum !== undefined &&
      value.validation.minimum > value.validation.maximum
    )
      context.addIssue({
        code: "custom",
        path: ["validation", "maximum"],
        message: "Maximum cannot be below minimum",
      });
  });
