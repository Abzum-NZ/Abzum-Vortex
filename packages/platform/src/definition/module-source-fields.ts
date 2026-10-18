import { z } from "zod";
import {
  personalDataClassSchema,
  publicDisplaySchema,
  searchPrioritySchema,
} from "../catalogue/catalogues";
import {
  builderKeySchema,
  namespacedKeySchema,
  sourceQualifiedRecordTypeSchema,
} from "../catalogue/identifiers";
import {
  calculationMaximumNestingDepth,
  calculationMaximumOperandCount,
  calculationResultTypesByOperation,
  jsonValueSchema,
  labelSchema,
  safeHttpsUrlSchema,
} from "../catalogue/common";
import {
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedRelationshipSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "./definition-source-common";
import { parseExactDecimal } from "../records/exact-decimal";
import {
  currencyCodeSchema,
  exactDecimalFitsDigits,
  exactDecimalWithinBounds,
  inspectRecordRichText,
  recordRichTextDocumentSchema,
  sourceExactDecimalTextSchema,
  sourcePersonLinkValueSchema,
  sourceRecordLinkValueSchema,
  type FormattedTextAllowedBlock,
} from "../records/module-field-values";

// ---------------------------------------------------------------------------
// Module field catalogue (current: exact-decimal text at every numeric
// boundary, complete typed table columns).
// ---------------------------------------------------------------------------

const sourceOptionSchema = z
  .object({
    value: sourceProvenanceUnchanged(z.string().min(1).max(120)),
    label: sourceProvenanceUnchanged(labelSchema),
    required_permission: sourceProvenanceTarget(namespacedKeySchema.optional(), [
      "requiredPermissionId",
    ]),
  })
  .strict();
const emptySettingsSchema = z.object({}).strict();
const sourceTextFormatSchema = z.enum(["uuid"]);
const sourceTextSettingsSchema = z
  .object({
    max_length: sourceProvenanceUnchanged(z.number().int().min(1).max(100_000)),
    format: sourceProvenanceUnchanged(sourceTextFormatSchema.optional()),
  })
  .strict();
const sourceLongTextSettingsSchema = z
  .object({ max_length: sourceProvenanceUnchanged(z.number().int().min(1).max(1_000_000)) })
  .strict();
export const formattedTextAllowedBlockSchema = z.enum([
  "paragraph",
  "heading",
  "list",
  "table",
  "link",
  "attachment",
]);
const sourceFormattedTextSettingsSchema = z
  .object({
    allowed_blocks: sourceProvenanceUnchanged(z.array(formattedTextAllowedBlockSchema).min(1)),
    max_length: sourceProvenanceUnchanged(z.number().int().positive().optional()),
  })
  .strict();
const sourceWholeNumberSettingsSchema = z
  .object({
    minimum: sourceProvenanceTarget(z.number().int().optional(), ["minimum"]),
    maximum: sourceProvenanceTarget(z.number().int().optional(), ["maximum"]),
    step: sourceProvenanceUnchanged(z.number().int().positive().optional()),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined || value.maximum === undefined || value.maximum >= value.minimum,
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );

export const exactRangeValid = (minimum?: string, maximum?: string): boolean => {
  const parsedMinimum = minimum === undefined ? undefined : parseExactDecimal(minimum);
  const parsedMaximum = maximum === undefined ? undefined : parseExactDecimal(maximum);
  return (
    parsedMinimum !== undefined &&
    parsedMaximum !== undefined &&
    exactDecimalWithinBounds(parsedMinimum, undefined, parsedMaximum)
  );
};

const sourceDecimalSettingsSchema = z
  .object({
    digits_before_decimal: sourceProvenanceUnchanged(z.number().int().min(1).max(30)),
    decimal_places: sourceProvenanceTarget(z.number().int().min(0).max(12), ["decimalPlaces"]),
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
const sourceMoneySettingsSchema = z
  .object({
    currency_mode: sourceProvenanceTarget(z.enum(["fixed", "organization_default"]), [
      "currencyMode",
    ]),
    currency: sourceProvenanceUnchanged(currencyCodeSchema.optional()),
    minimum: sourceProvenanceTarget(sourceExactDecimalTextSchema.optional(), ["minimum"]),
    maximum: sourceProvenanceTarget(sourceExactDecimalTextSchema.optional(), ["maximum"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.currency_mode === "fixed") !== (value.currency !== undefined))
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Fixed money requires exactly one currency",
      });
    if (
      value.minimum !== undefined &&
      value.maximum !== undefined &&
      !exactRangeValid(value.minimum, value.maximum)
    )
      context.addIssue({
        code: "custom",
        path: ["maximum"],
        message: "Maximum cannot be below minimum",
      });
  });
const sourceDateSettingsSchema = z
  .object({
    earliest: sourceProvenanceUnchanged(z.iso.date().optional()),
    latest: sourceProvenanceUnchanged(z.iso.date().optional()),
  })
  .strict();
const sourceDateTimeSettingsSchema = z
  .object({
    display_time_zone: sourceProvenanceTarget(
      z.enum(["person", "organization", "utc"]).optional(),
      ["displayTimeZone"],
    ),
  })
  .strict();
const sourceChoiceSettingsSchema = z
  .object({ options: sourceProvenanceUnchanged(z.array(sourceOptionSchema).min(1).max(200)) })
  .strict();
const sourceSeveralChoicesSettingsSchema = z
  .object({
    options: sourceProvenanceUnchanged(z.array(sourceOptionSchema).min(1).max(200)),
    maximum_selections: sourceProvenanceUnchanged(z.number().int().min(1).max(200).optional()),
  })
  .strict();
const sourceReferenceNumberSettingsSchema = z
  .object({
    prefix: sourceProvenanceUnchanged(z.string().max(20).optional()),
    suffix: sourceProvenanceUnchanged(z.string().max(20).optional()),
    digits: sourceProvenanceUnchanged(z.number().int().min(1).max(20)),
    starting_number: sourceProvenanceUnchanged(z.number().int().positive().optional()),
  })
  .strict();
const sourcePhoneSettingsSchema = z
  .object({ default_country: sourceProvenanceUnchanged(z.string().length(2).optional()) })
  .strict();
const sourceWebAddressSettingsSchema = z
  .object({
    allowed_schemes: sourceProvenanceUnchanged(z.array(z.literal("https")).min(1).optional()),
  })
  .strict();

const sourceTableColumnBase = {
  key: sourceProvenanceUnchanged(builderKeySchema),
  required: sourceProvenanceUnchanged(z.boolean()),
};
const sourceTableColumnSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("text")),
      settings: sourceProvenanceUnchanged(sourceTextSettingsSchema),
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("whole_number")),
      settings: sourceProvenanceUnchanged(sourceWholeNumberSettingsSchema),
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("decimal_number")),
      settings: sourceProvenanceUnchanged(sourceDecimalSettingsSchema),
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("money")),
      settings: sourceProvenanceUnchanged(sourceMoneySettingsSchema),
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("yes_no")),
      settings: sourceProvenanceUnchanged(emptySettingsSchema),
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("date")),
      settings: sourceProvenanceUnchanged(sourceDateSettingsSchema),
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("date_time")),
      settings: sourceProvenanceUnchanged(sourceDateTimeSettingsSchema),
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: sourceProvenanceUnchanged(z.literal("choice")),
      settings: sourceProvenanceUnchanged(sourceChoiceSettingsSchema),
    })
    .strict(),
]);
const sourceTableSettingsSchema = z
  .object({
    minimum_rows: sourceProvenanceUnchanged(z.number().int().min(0)),
    maximum_rows: sourceProvenanceUnchanged(z.number().int().min(1).max(1_000)),
    columns: sourceProvenanceUnchanged(z.array(sourceTableColumnSchema).min(1).max(40)),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maximum_rows < value.minimum_rows)
      context.addIssue({
        code: "custom",
        path: ["maximum_rows"],
        message: "Maximum rows cannot be below minimum rows",
      });
    const keys = value.columns.map((column) => column.key);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["columns"],
        message: "Table column keys must be unique",
      });
  });
const sourceLinkSettingsSchema = z
  .object({
    target: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["target/**"]),
    reverse_key: sourceProvenanceUnchanged(builderKeySchema),
    on_parent_delete: sourceProvenanceUnchanged(
      z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
    ),
    application_root_required: sourceProvenanceTarget(z.boolean().optional(), [
      "applicationRootIdRequired",
    ]),
    legacy_person_field: sourceProvenanceTarget(builderKeySchema.optional(), [
      "legacyPersonFieldId",
    ]),
  })
  .strict();
const sourceMultiLinkSettingsSchema = z
  .object({
    targets: sourceProvenanceUnchanged(
      z
        .array(sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["targets/#/**"]))
        .min(2)
        .max(20),
    ),
    on_parent_delete: sourceProvenanceUnchanged(
      z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
    ),
  })
  .strict();
const sourcePersonLinkSettingsSchema = z
  .object({
    audience: sourceProvenanceTarget(
      z.enum([
        "organization_accounts",
        "application_accounts",
        "organization_identities_and_external_requesters",
      ]),
      ["audience"],
    ),
    application_root_required: sourceProvenanceTarget(z.boolean(), ["applicationRootIdRequired"]),
    on_person_deactivation: sourceProvenanceUnchanged(
      z.enum(["retain_reference", "empty_optional", "refuse_deactivation"]),
    ),
  })
  .strict();

/** Closed safety limits for one nested numeric expression are declared in ./common. */
const sourceCalculationNumberOperationSchema = z.enum(["add", "subtract", "multiply", "divide"]);
const sourceCalculationNumberOperandSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("field")),
      field: sourceProvenanceTarget(builderKeySchema, [
        "fieldId",
        "fieldIds/#",
        "dependencyFieldIds/#",
      ]),
    })
    .strict(),
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("literal")),
      value: sourceProvenanceTarget(sourceExactDecimalTextSchema, ["value"]),
    })
    .strict(),
]);
/**
 * One value of a numeric calculation as authored: a named field, an exact decimal literal, or a
 * further numeric operation over further values. A nested operation is the same closed form the
 * calculation itself uses, so a new formula needs no new expression and no engine change.
 */
type SourceCalculationNumberValue =
  | z.infer<typeof sourceCalculationNumberOperandSchema>
  | {
      source: "numeric";
      numeric_operation: z.infer<typeof sourceCalculationNumberOperationSchema>;
      operands: SourceCalculationNumberValue[];
    };
const inspectSourceCalculationNumberValue = (
  value: SourceCalculationNumberValue,
  depth = 1,
): { depth: number; values: number; fields: number } => {
  if (value.source !== "numeric")
    return { depth, values: 1, fields: value.source === "field" ? 1 : 0 };
  const inspected = value.operands.map((operand) =>
    inspectSourceCalculationNumberValue(operand, depth + 1),
  );
  return {
    depth: Math.max(depth, ...inspected.map((operand) => operand.depth)),
    values: 1 + inspected.reduce((total, operand) => total + operand.values, 0),
    fields: inspected.reduce((total, operand) => total + operand.fields, 0),
  };
};
const sourceCalculationNumberValueSchema: z.ZodType<SourceCalculationNumberValue> = z.lazy(() =>
  z
    .discriminatedUnion("source", [
      ...sourceCalculationNumberOperandSchema.options,
      z
        .object({
          source: sourceProvenanceUnchanged(z.literal("numeric")),
          numeric_operation: sourceProvenanceTarget(sourceCalculationNumberOperationSchema, [
            "operation",
          ]),
          operands: sourceProvenanceUnchanged(
            z.array(sourceCalculationNumberValueSchema).min(2).max(20),
          ),
        })
        .strict(),
    ])
    .superRefine((value, context) => {
      const inspected = inspectSourceCalculationNumberValue(value);
      if (inspected.depth > calculationMaximumNestingDepth)
        context.addIssue({
          code: "custom",
          message: `Numeric nesting cannot exceed ${calculationMaximumNestingDepth} levels`,
        });
      if (inspected.values > calculationMaximumOperandCount)
        context.addIssue({
          code: "custom",
          message: `A numeric calculation cannot exceed ${calculationMaximumOperandCount} values`,
        });
    }),
);
const sourceCalculationExpressionSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: sourceProvenanceTarget(z.literal("join_text"), ["kind"]),
      fields: sourceProvenanceUnchanged(
        z
          .array(sourceProvenanceTarget(builderKeySchema, ["fieldIds/#", "dependencyFieldIds/#"]))
          .min(1)
          .max(20),
      ),
      separator: sourceProvenanceUnchanged(z.string().max(20)),
    })
    .strict(),
  z
    .object({
      operation: sourceProvenanceTarget(z.literal("numeric"), ["kind"]),
      numeric_operation: sourceProvenanceTarget(sourceCalculationNumberOperationSchema, [
        "operation",
      ]),
      operands: sourceProvenanceUnchanged(
        z.array(sourceCalculationNumberValueSchema).min(2).max(20),
      ),
    })
    .strict(),
  z
    .object({
      operation: sourceProvenanceTarget(z.literal("condition"), ["kind"]),
      condition: sourceProvenanceUnchanged(sourceConditionSchema),
    })
    .strict(),
  z
    .object({
      operation: sourceProvenanceTarget(z.literal("date_offset"), ["kind"]),
      date_field: sourceProvenanceTarget(builderKeySchema, ["dateFieldId", "dependencyFieldIds/#"]),
      amount: sourceProvenanceUnchanged(sourceCalculationNumberOperandSchema),
      unit: sourceProvenanceUnchanged(z.enum(["days", "weeks", "months", "years"])),
    })
    .strict(),
  z
    .object({
      operation: sourceProvenanceTarget(z.literal("deadline_passed"), ["kind"]),
      due_field: sourceProvenanceTarget(builderKeySchema, ["dueFieldId", "dependencyFieldIds/#"]),
      status_field: sourceProvenanceTarget(builderKeySchema.optional(), [
        "statusFieldId",
        "dependencyFieldIds/#",
      ]),
      terminal_status_values: sourceProvenanceUnchanged(z.array(jsonValueSchema).max(20)),
    })
    .strict(),
]);
const sourceCalculationSettingsSchema = z
  .object({
    result_type: sourceProvenanceUnchanged(
      z.enum(["text", "whole_number", "decimal_number", "money", "yes_no", "date", "date_time"]),
    ),
    evaluation: sourceProvenanceUnchanged(z.enum(["read_time", "stored"]).optional()),
    decimal_places: sourceProvenanceTarget(z.number().int().min(0).max(12).optional(), [
      "decimalPlaces",
    ]),
    expression: sourceProvenanceUnchanged(sourceCalculationExpressionSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const operation = value.expression.operation;
    const validResultTypes: readonly string[] = calculationResultTypesByOperation[operation];
    if (!validResultTypes.includes(value.result_type))
      context.addIssue({
        code: "custom",
        path: ["result_type"],
        message: "Calculation result type must match its operation",
      });
    if (
      value.expression.operation === "numeric" &&
      value.expression.operands.reduce(
        (total, operand) => total + inspectSourceCalculationNumberValue(operand).values,
        0,
      ) > calculationMaximumOperandCount
    )
      context.addIssue({
        code: "custom",
        path: ["expression", "operands"],
        message: `A numeric calculation cannot exceed ${calculationMaximumOperandCount} values`,
      });
    if (
      value.expression.operation === "numeric" &&
      value.expression.operands.every(
        (operand) => inspectSourceCalculationNumberValue(operand).fields === 0,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["expression", "operands"],
        message: "A numeric calculation reads at least one field",
      });
    if (value.evaluation === "stored" && operation === "deadline_passed")
      context.addIssue({
        code: "custom",
        path: ["evaluation"],
        message: "A deadline-passed calculation uses the current time and is read-time",
      });
    if (
      value.decimal_places !== undefined &&
      value.result_type !== "decimal_number" &&
      value.result_type !== "money"
    )
      context.addIssue({
        code: "custom",
        path: ["decimal_places"],
        message: "Only decimal and money calculations declare result precision",
      });
  });
const sourceTotalSettingsSchema = z
  .object({
    relationship: sourceProvenanceTarget(sourceQualifiedRelationshipSchema, ["relationshipId"]),
    operation: sourceProvenanceUnchanged(z.enum(["count", "sum", "minimum", "maximum", "average"])),
    result_type: sourceProvenanceUnchanged(
      z.enum(["text", "whole_number", "decimal_number", "money", "yes_no", "date", "date_time"]),
    ),
    field: sourceProvenanceTarget(builderKeySchema.optional(), ["fieldId"]),
    filter: sourceProvenanceUnchanged(sourceConditionSchema.optional()),
    currency: sourceProvenanceUnchanged(currencyCodeSchema.optional()),
    decimal_places: sourceProvenanceTarget(z.number().int().min(0).max(12).optional(), [
      "decimalPlaces",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const needsField = value.operation !== "count";
    if (needsField !== (value.field !== undefined))
      context.addIssue({
        code: "custom",
        path: ["field"],
        message: "Only non-count totals require a field",
      });
    if (value.currency !== undefined && value.operation !== "sum")
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency is supported only for sum totals",
      });
    if (value.decimal_places !== undefined && value.operation !== "average")
      context.addIssue({
        code: "custom",
        path: ["decimal_places"],
        message: "Only average totals declare result precision",
      });
    if (value.operation === "count" && value.result_type !== "whole_number")
      context.addIssue({
        code: "custom",
        path: ["result_type"],
        message: "Count totals produce a whole number",
      });
    if (
      ["sum", "average"].includes(value.operation) &&
      !["whole_number", "decimal_number", "money"].includes(value.result_type)
    )
      context.addIssue({
        code: "custom",
        path: ["result_type"],
        message: "Sum and average totals require a numeric result type",
      });
  });
const sourceAttachmentSettingsSchema = z
  .object({
    allowed_kinds: sourceProvenanceUnchanged(
      z
        .array(
          z.enum([
            "image",
            "document",
            "spreadsheet",
            "presentation",
            "audio",
            "video",
            "archive",
            "text",
            "other",
          ]),
        )
        .min(1),
    ),
    allowed_extensions: sourceProvenanceUnchanged(
      z
        .array(z.string().regex(/^\.[a-z0-9]+$/))
        .min(1)
        .optional(),
    ),
    max_file_size_mb: sourceProvenanceUnchanged(z.number().positive().max(5_000)),
    multiple: sourceProvenanceUnchanged(z.boolean()),
    max_files: sourceProvenanceUnchanged(z.number().int().min(2).max(100).optional()),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.multiple !== (value.max_files !== undefined))
      context.addIssue({
        code: "custom",
        path: ["max_files"],
        message: "max_files is required only for multiple attachments",
      });
  });

const sourceFieldBase = {
  id: sourceProvenanceTarget(sourceAliasSchema, ["fieldId"]),
  key: sourceProvenanceUnchanged(builderKeySchema),
  label: sourceProvenanceUnchanged(labelSchema),
  help_text: sourceProvenanceUnchanged(z.string().max(200).optional()),
  required: sourceProvenanceUnchanged(z.boolean()),
  unique: sourceProvenanceUnchanged(z.boolean()),
  filterable: sourceProvenanceUnchanged(z.boolean()),
  sortable: sourceProvenanceUnchanged(z.boolean()),
  search_priority: sourceProvenanceUnchanged(searchPrioritySchema.optional()),
  personal_data: sourceProvenanceUnchanged(personalDataClassSchema),
  public_display: sourceProvenanceUnchanged(publicDisplaySchema),
};
const sourceField = <K extends string, S extends z.ZodType, D extends z.ZodType>(
  type: K,
  settings: S,
  defaultValue: D,
) =>
  z
    .object({
      ...sourceFieldBase,
      type: sourceProvenanceUnchanged(z.literal(type)),
      settings: sourceProvenanceUnchanged(settings),
      default: sourceProvenanceTarget(defaultValue.optional(), ["default/**"], true),
    })
    .strict();
const noDefaultSchema = z.never();
const sourceTableDefaultSchema = z.array(z.record(builderKeySchema, jsonValueSchema)).max(1_000);

const sourceFieldMembers = [
  sourceField("text", sourceTextSettingsSchema, z.string()),
  sourceField("long_text", sourceLongTextSettingsSchema, z.string()),
  sourceField("formatted_text", sourceFormattedTextSettingsSchema, recordRichTextDocumentSchema),
  sourceField("whole_number", sourceWholeNumberSettingsSchema, z.number().int()),
  sourceField("decimal_number", sourceDecimalSettingsSchema, sourceExactDecimalTextSchema),
  sourceField("money", sourceMoneySettingsSchema, sourceExactDecimalTextSchema),
  sourceField("yes_no", emptySettingsSchema, z.boolean()),
  sourceField("date", sourceDateSettingsSchema, z.iso.date()),
  sourceField("date_time", sourceDateTimeSettingsSchema, z.iso.datetime({ offset: true })),
  sourceField("choice", sourceChoiceSettingsSchema, z.string()),
  sourceField("several_choices", sourceSeveralChoicesSettingsSchema, z.array(z.string()).max(200)),
  sourceField("reference_number", sourceReferenceNumberSettingsSchema, noDefaultSchema),
  sourceField("email_address", emptySettingsSchema, z.email()),
  sourceField("phone_number", sourcePhoneSettingsSchema, z.string()),
  sourceField("web_address", sourceWebAddressSettingsSchema, safeHttpsUrlSchema),
  sourceField("table", sourceTableSettingsSchema, sourceTableDefaultSchema),
  sourceField("link", sourceLinkSettingsSchema, sourceRecordLinkValueSchema),
  sourceField("link_to_one_of_several", sourceMultiLinkSettingsSchema, sourceRecordLinkValueSchema),
  sourceField("link_to_person", sourcePersonLinkSettingsSchema, sourcePersonLinkValueSchema),
  sourceField("calculation", sourceCalculationSettingsSchema, noDefaultSchema),
  sourceField("total", sourceTotalSettingsSchema, noDefaultSchema),
  sourceField("attachment", sourceAttachmentSettingsSchema, noDefaultSchema),
] as const;

const textFormatValid = (
  format: z.infer<typeof sourceTextFormatSchema> | undefined,
  value: string,
) =>
  format === undefined ||
  (format === "uuid" && z.uuid().safeParse(value).success);
const wholeNumberValid = (
  value: number,
  settings: z.infer<typeof sourceWholeNumberSettingsSchema>,
) =>
  (settings.minimum === undefined || value >= settings.minimum) &&
  (settings.maximum === undefined || value <= settings.maximum) &&
  (settings.step === undefined || (value - (settings.minimum ?? 0)) % settings.step === 0);
const decimalValid = (value: string, settings: z.infer<typeof sourceDecimalSettingsSchema>) => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return (
    exactDecimalFitsDigits(parsed, settings.digits_before_decimal, settings.decimal_places) &&
    exactDecimalWithinBounds(
      parsed,
      settings.minimum === undefined ? undefined : parseExactDecimal(settings.minimum),
      settings.maximum === undefined ? undefined : parseExactDecimal(settings.maximum),
    )
  );
};
const moneyAmountValid = (value: string, settings: z.infer<typeof sourceMoneySettingsSchema>) => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return exactDecimalWithinBounds(
    parsed,
    settings.minimum === undefined ? undefined : parseExactDecimal(settings.minimum),
    settings.maximum === undefined ? undefined : parseExactDecimal(settings.maximum),
  );
};
const formattedTextValid = (
  value: z.infer<typeof recordRichTextDocumentSchema>,
  settings: z.infer<typeof sourceFormattedTextSettingsSchema>,
) => {
  const inspected = inspectRecordRichText(value);
  const allowed = new Set<FormattedTextAllowedBlock>(settings.allowed_blocks);
  return (
    [...inspected.usedBlocks].every((kind) => allowed.has(kind)) &&
    (settings.max_length === undefined || inspected.visibleTextLength <= settings.max_length)
  );
};
const tableCellDefaultValid = (
  column: z.infer<typeof sourceTableColumnSchema>,
  value: unknown,
): boolean => {
  switch (column.type) {
    case "text":
      return (
        typeof value === "string" &&
        value.length <= column.settings.max_length &&
        textFormatValid(column.settings.format, value)
      );
    case "whole_number":
      return Number.isInteger(value) && wholeNumberValid(value as number, column.settings);
    case "decimal_number":
      return (
        sourceExactDecimalTextSchema.safeParse(value).success &&
        decimalValid(value as string, column.settings)
      );
    case "money":
      return (
        sourceExactDecimalTextSchema.safeParse(value).success &&
        moneyAmountValid(value as string, column.settings)
      );
    case "yes_no":
      return typeof value === "boolean";
    case "date":
      return (
        z.iso.date().safeParse(value).success &&
        (column.settings.earliest === undefined || (value as string) >= column.settings.earliest) &&
        (column.settings.latest === undefined || (value as string) <= column.settings.latest)
      );
    case "date_time":
      return z.iso.datetime({ offset: true }).safeParse(value).success;
    case "choice":
      return (
        typeof value === "string" &&
        column.settings.options.some((option) => option.value === value)
      );
  }
};
const tableDefaultValid = (
  value: readonly Record<string, unknown>[],
  settings: z.infer<typeof sourceTableSettingsSchema>,
) => {
  const keys = new Set(settings.columns.map((column) => column.key));
  return (
    value.length >= settings.minimum_rows &&
    value.length <= settings.maximum_rows &&
    value.every(
      (row) =>
        Object.keys(row).every((key) => keys.has(key)) &&
        settings.columns.every(
          (column) =>
            (!column.required && !Object.prototype.hasOwnProperty.call(row, column.key)) ||
            (Object.prototype.hasOwnProperty.call(row, column.key) &&
              tableCellDefaultValid(column, row[column.key])),
        ),
    )
  );
};

export const moduleSourceFieldSchema = z
  .discriminatedUnion("type", sourceFieldMembers)
  .superRefine((value, context) => {
    if (value.default === undefined) return;
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", path: ["default"], message });
    switch (value.type) {
      case "text":
        if (
          value.default.length > value.settings.max_length ||
          !textFormatValid(value.settings.format, value.default)
        )
          invalid("Default must match the text length and format settings");
        break;
      case "long_text":
        if (value.default.length > value.settings.max_length)
          invalid("Default must match the long-text length setting");
        break;
      case "formatted_text":
        if (!formattedTextValid(value.default, value.settings))
          invalid("Default must match the formatted-text block and length settings");
        break;
      case "whole_number":
        if (!wholeNumberValid(value.default, value.settings))
          invalid("Default must match the whole-number range and step settings");
        break;
      case "decimal_number":
        if (!decimalValid(value.default, value.settings))
          invalid("Default must match the exact decimal precision and range settings");
        break;
      case "money":
        if (!moneyAmountValid(value.default, value.settings))
          invalid("Default amount must match the exact money range settings");
        break;
      case "date":
        if (
          (value.settings.earliest !== undefined && value.default < value.settings.earliest) ||
          (value.settings.latest !== undefined && value.default > value.settings.latest)
        )
          invalid("Default must match the date range settings");
        break;
      case "choice":
        if (!value.settings.options.some((option) => option.value === value.default))
          invalid("Default must be one declared choice");
        break;
      case "several_choices":
        if (
          !value.default.every((item) =>
            value.settings.options.some((option) => option.value === item),
          ) ||
          (value.settings.maximum_selections !== undefined &&
            value.default.length > value.settings.maximum_selections)
        )
          invalid("Every default must be a declared choice within the selection limit");
        break;
      case "table":
        if (!tableDefaultValid(value.default, value.settings))
          invalid("Default must match the configured table columns and row limits");
        break;
      case "link":
        if (value.default.record_type !== value.settings.target)
          invalid("Default record type must match the configured link target");
        break;
      case "link_to_one_of_several":
        if (!value.settings.targets.includes(value.default.record_type))
          invalid("Default record type must be one configured link target");
        break;
      case "yes_no":
      case "date_time":
      case "email_address":
      case "phone_number":
      case "web_address":
      case "link_to_person":
        break;
    }
  });
