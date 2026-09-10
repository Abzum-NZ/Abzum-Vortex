import { z } from "zod";
import { personalDataClassSchema, publicDisplaySchema, searchPrioritySchema } from "./catalogues";
import { jsonValueSchema, safeHttpsUrlSchema } from "./common";
import {
  sourceConditionSchema,
  sourceQualifiedRecordTypeSchema,
  sourceQualifiedRelationshipSchema,
} from "./definition-source-common";
import { parseExactDecimal } from "./exact-decimal";
import { builderKeySchema, namespacedKeySchema, organizationAccountIdSchema } from "./identifiers";
import {
  exactDecimalFitsDigitsV2,
  exactDecimalWithinBoundsV2,
  inspectRecordRichTextV2,
  recordRichTextDocumentV2Schema,
  sourceExactDecimalTextV2Schema,
  sourcePersonLinkValueV2Schema,
  sourceRecordLinkValueV2Schema,
  sourceMoneyValueV2Schema,
  currencyCodeV2Schema,
  type FormattedTextAllowedBlockV2,
} from "./module-field-values-v2";
import { moduleSourceDocumentSchema } from "./module-source-contracts";
import { sourceAliasSchema } from "./definition-source-common";

export const moduleSourceContractVersionV2 = "2.0.0" as const;

const sourceOptionV2Schema = z
  .object({
    value: z.string().min(1).max(120),
    label: z.string().min(1).max(60),
    required_permission: namespacedKeySchema.optional(),
  })
  .strict();
const emptySettingsSchema = z.object({}).strict();
const sourceTextFormatV2Schema = z.enum(["email_address", "web_address", "uuid"]);
const sourceTextSettingsV2Schema = z
  .object({
    max_length: z.number().int().min(1).max(100_000),
    format: sourceTextFormatV2Schema.optional(),
  })
  .strict();
const sourceLongTextSettingsV2Schema = z
  .object({ max_length: z.number().int().min(1).max(1_000_000) })
  .strict();
const formattedTextAllowedBlockV2Schema = z.enum([
  "paragraph",
  "heading",
  "list",
  "table",
  "link",
  "attachment",
]);
const sourceFormattedTextSettingsV2Schema = z
  .object({
    allowed_blocks: z.array(formattedTextAllowedBlockV2Schema).min(1),
    max_length: z.number().int().positive().optional(),
  })
  .strict();
const sourceWholeNumberSettingsV2Schema = z
  .object({
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
    step: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined || value.maximum === undefined || value.maximum >= value.minimum,
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );

const exactRangeValid = (minimum?: string, maximum?: string): boolean => {
  const parsedMinimum = minimum === undefined ? undefined : parseExactDecimal(minimum);
  const parsedMaximum = maximum === undefined ? undefined : parseExactDecimal(maximum);
  return (
    parsedMinimum !== undefined &&
    parsedMaximum !== undefined &&
    exactDecimalWithinBoundsV2(parsedMinimum, undefined, parsedMaximum)
  );
};

const sourceDecimalSettingsV2Schema = z
  .object({
    digits_before_decimal: z.number().int().min(1).max(30),
    decimal_places: z.number().int().min(0).max(12),
    minimum: sourceExactDecimalTextV2Schema.optional(),
    maximum: sourceExactDecimalTextV2Schema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined ||
      value.maximum === undefined ||
      exactRangeValid(value.minimum, value.maximum),
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );
const sourceMoneySettingsV2Schema = z
  .object({
    currency_mode: z.enum(["fixed", "organisation_default"]),
    currency: currencyCodeV2Schema.optional(),
    minimum: sourceExactDecimalTextV2Schema.optional(),
    maximum: sourceExactDecimalTextV2Schema.optional(),
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
const sourceDateSettingsV2Schema = z
  .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
  .strict();
const sourceDateTimeSettingsV2Schema = z
  .object({ display_time_zone: z.enum(["person", "organisation", "utc"]).optional() })
  .strict();
const sourceChoiceSettingsV2Schema = z
  .object({ options: z.array(sourceOptionV2Schema).min(1).max(200) })
  .strict();
const sourceSeveralChoicesSettingsV2Schema = z
  .object({
    options: z.array(sourceOptionV2Schema).min(1).max(200),
    maximum_selections: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const sourceReferenceNumberSettingsV2Schema = z
  .object({
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    digits: z.number().int().min(1).max(20),
    starting_number: z.number().int().positive().optional(),
  })
  .strict();
const sourcePhoneSettingsV2Schema = z
  .object({ default_country: z.string().length(2).optional() })
  .strict();
const sourceWebAddressSettingsV2Schema = z
  .object({ allowed_schemes: z.array(z.literal("https")).min(1).optional() })
  .strict();

const sourceTableColumnBase = { key: builderKeySchema, required: z.boolean() };
const sourceTableColumnV2Schema = z.discriminatedUnion("type", [
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("text"),
      settings: sourceTextSettingsV2Schema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("whole_number"),
      settings: sourceWholeNumberSettingsV2Schema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("decimal_number"),
      settings: sourceDecimalSettingsV2Schema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("money"),
      settings: sourceMoneySettingsV2Schema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("yes_no"),
      settings: emptySettingsSchema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("date"),
      settings: sourceDateSettingsV2Schema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("date_time"),
      settings: sourceDateTimeSettingsV2Schema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("choice"),
      settings: sourceChoiceSettingsV2Schema,
    })
    .strict(),
]);
const sourceTableSettingsV2Schema = z
  .object({
    minimum_rows: z.number().int().min(0),
    maximum_rows: z.number().int().min(1).max(1_000),
    columns: z.array(sourceTableColumnV2Schema).min(1).max(40),
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
const sourceLinkSettingsV2Schema = z
  .object({
    target: sourceQualifiedRecordTypeSchema,
    reverse_key: builderKeySchema,
    on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const sourceMultiLinkSettingsV2Schema = z
  .object({
    targets: z.array(sourceQualifiedRecordTypeSchema).min(2).max(20),
    on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const sourcePersonLinkSettingsV2Schema = z
  .object({
    audience: z.enum([
      "organisation_accounts",
      "application_accounts",
      "organisation_identities_and_external_requesters",
    ]),
    application_root_required: z.boolean(),
    on_person_deactivation: z.enum(["retain_reference", "empty_optional", "refuse_deactivation"]),
  })
  .strict();

const sourceCalculationNumberOperandV2Schema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("literal"), value: sourceExactDecimalTextV2Schema }).strict(),
]);
const sourceCalculationExpressionV2Schema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("subtract_percentage"),
      amount_field: builderKeySchema,
      percentage_field: builderKeySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("join_text"),
      fields: z.array(builderKeySchema).min(1).max(20),
      separator: z.string().max(20),
    })
    .strict(),
  z
    .object({
      operation: z.literal("numeric"),
      numeric_operation: z.enum(["add", "subtract", "multiply", "divide"]),
      operands: z.array(sourceCalculationNumberOperandV2Schema).min(2).max(20),
    })
    .strict(),
  z.object({ operation: z.literal("condition"), condition: sourceConditionSchema }).strict(),
  z
    .object({
      operation: z.literal("date_offset"),
      date_field: builderKeySchema,
      amount: sourceCalculationNumberOperandV2Schema,
      unit: z.enum(["days", "weeks", "months", "years"]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("deadline_passed"),
      due_field: builderKeySchema,
      status_field: builderKeySchema.optional(),
      terminal_status_values: z.array(jsonValueSchema).max(20),
    })
    .strict(),
]);
const sourceCalculationSettingsV2Schema = z
  .object({
    result_type: z.enum([
      "text",
      "whole_number",
      "decimal_number",
      "money",
      "yes_no",
      "date",
      "date_time",
    ]),
    decimal_places: z.number().int().min(0).max(12).optional(),
    expression: sourceCalculationExpressionV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const operation = value.expression.operation;
    const validResultTypes: Readonly<Record<typeof operation, readonly string[]>> = {
      join_text: ["text"],
      numeric: ["whole_number", "decimal_number", "money"],
      subtract_percentage: ["decimal_number", "money"],
      condition: ["yes_no"],
      date_offset: ["date", "date_time"],
      deadline_passed: ["yes_no"],
    };
    if (!validResultTypes[operation].includes(value.result_type))
      context.addIssue({
        code: "custom",
        path: ["result_type"],
        message: "Calculation result type must match its operation",
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
const sourceTotalSettingsV2Schema = z
  .object({
    relationship: sourceQualifiedRelationshipSchema,
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    result_type: z.enum([
      "text",
      "whole_number",
      "decimal_number",
      "money",
      "yes_no",
      "date",
      "date_time",
    ]),
    field: builderKeySchema.optional(),
    filter: sourceConditionSchema.optional(),
    currency: currencyCodeV2Schema.optional(),
    decimal_places: z.number().int().min(0).max(12).optional(),
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
const sourceAttachmentSettingsV2Schema = z
  .object({
    allowed_kinds: z
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
    allowed_extensions: z
      .array(z.string().regex(/^\.[a-z0-9]+$/))
      .min(1)
      .optional(),
    max_file_size_mb: z.number().positive().max(5_000),
    multiple: z.boolean(),
    max_files: z.number().int().min(2).max(100).optional(),
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

const sourceFieldBaseV2 = {
  id: sourceAliasSchema,
  key: builderKeySchema,
  label: z.string().min(1).max(60),
  help_text: z.string().max(200).optional(),
  required: z.boolean(),
  unique: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  search_priority: searchPrioritySchema.optional(),
  personal_data: personalDataClassSchema,
  public_display: publicDisplaySchema,
};
const sourceFieldV2 = <K extends string, S extends z.ZodType, D extends z.ZodType>(
  type: K,
  settings: S,
  defaultValue: D,
) =>
  z
    .object({
      ...sourceFieldBaseV2,
      type: z.literal(type),
      settings,
      default: defaultValue.optional(),
    })
    .strict();
const noDefaultSchema = z.never();
const sourceTableDefaultV2Schema = z.array(z.record(builderKeySchema, jsonValueSchema));

const sourceFieldMembersV2 = [
  sourceFieldV2("text", sourceTextSettingsV2Schema, z.string()),
  sourceFieldV2("long_text", sourceLongTextSettingsV2Schema, z.string()),
  sourceFieldV2(
    "formatted_text",
    sourceFormattedTextSettingsV2Schema,
    recordRichTextDocumentV2Schema,
  ),
  sourceFieldV2("whole_number", sourceWholeNumberSettingsV2Schema, z.number().int()),
  sourceFieldV2("decimal_number", sourceDecimalSettingsV2Schema, sourceExactDecimalTextV2Schema),
  sourceFieldV2("money", sourceMoneySettingsV2Schema, sourceExactDecimalTextV2Schema),
  sourceFieldV2("yes_no", emptySettingsSchema, z.boolean()),
  sourceFieldV2("date", sourceDateSettingsV2Schema, z.iso.date()),
  sourceFieldV2("date_time", sourceDateTimeSettingsV2Schema, z.iso.datetime({ offset: true })),
  sourceFieldV2("choice", sourceChoiceSettingsV2Schema, z.string()),
  sourceFieldV2("several_choices", sourceSeveralChoicesSettingsV2Schema, z.array(z.string())),
  sourceFieldV2("reference_number", sourceReferenceNumberSettingsV2Schema, noDefaultSchema),
  sourceFieldV2("email_address", emptySettingsSchema, z.email()),
  sourceFieldV2("phone_number", sourcePhoneSettingsV2Schema, z.string()),
  sourceFieldV2("web_address", sourceWebAddressSettingsV2Schema, safeHttpsUrlSchema),
  sourceFieldV2("table", sourceTableSettingsV2Schema, sourceTableDefaultV2Schema),
  sourceFieldV2("link", sourceLinkSettingsV2Schema, sourceRecordLinkValueV2Schema),
  sourceFieldV2(
    "link_to_one_of_several",
    sourceMultiLinkSettingsV2Schema,
    sourceRecordLinkValueV2Schema,
  ),
  sourceFieldV2("link_to_person", sourcePersonLinkSettingsV2Schema, sourcePersonLinkValueV2Schema),
  sourceFieldV2("calculation", sourceCalculationSettingsV2Schema, noDefaultSchema),
  sourceFieldV2("total", sourceTotalSettingsV2Schema, noDefaultSchema),
  sourceFieldV2("attachment", sourceAttachmentSettingsV2Schema, noDefaultSchema),
] as const;

const textFormatValid = (
  format: z.infer<typeof sourceTextFormatV2Schema> | undefined,
  value: string,
) =>
  format === undefined ||
  (format === "email_address" && z.email().safeParse(value).success) ||
  (format === "web_address" &&
    z.url().safeParse(value).success &&
    new URL(value).protocol === "https:") ||
  (format === "uuid" && z.uuid().safeParse(value).success);
const wholeNumberValid = (
  value: number,
  settings: z.infer<typeof sourceWholeNumberSettingsV2Schema>,
) =>
  (settings.minimum === undefined || value >= settings.minimum) &&
  (settings.maximum === undefined || value <= settings.maximum) &&
  (settings.step === undefined || (value - (settings.minimum ?? 0)) % settings.step === 0);
const decimalValid = (value: string, settings: z.infer<typeof sourceDecimalSettingsV2Schema>) => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return (
    exactDecimalFitsDigitsV2(parsed, settings.digits_before_decimal, settings.decimal_places) &&
    exactDecimalWithinBoundsV2(
      parsed,
      settings.minimum === undefined ? undefined : parseExactDecimal(settings.minimum),
      settings.maximum === undefined ? undefined : parseExactDecimal(settings.maximum),
    )
  );
};
const moneyAmountValid = (value: string, settings: z.infer<typeof sourceMoneySettingsV2Schema>) => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return exactDecimalWithinBoundsV2(
    parsed,
    settings.minimum === undefined ? undefined : parseExactDecimal(settings.minimum),
    settings.maximum === undefined ? undefined : parseExactDecimal(settings.maximum),
  );
};
const formattedTextValid = (
  value: z.infer<typeof recordRichTextDocumentV2Schema>,
  settings: z.infer<typeof sourceFormattedTextSettingsV2Schema>,
) => {
  const inspected = inspectRecordRichTextV2(value);
  const allowed = new Set<FormattedTextAllowedBlockV2>(settings.allowed_blocks);
  return (
    [...inspected.usedBlocks].every((kind) => allowed.has(kind)) &&
    (settings.max_length === undefined || inspected.visibleTextLength <= settings.max_length)
  );
};
const tableCellDefaultValid = (
  column: z.infer<typeof sourceTableColumnV2Schema>,
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
        sourceExactDecimalTextV2Schema.safeParse(value).success &&
        decimalValid(value as string, column.settings)
      );
    case "money":
      return (
        sourceExactDecimalTextV2Schema.safeParse(value).success &&
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
  settings: z.infer<typeof sourceTableSettingsV2Schema>,
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

export const moduleSourceFieldV2Schema = z
  .discriminatedUnion("type", sourceFieldMembersV2)
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

const sourceActionInputBaseV2 = {
  key: builderKeySchema,
  label: z.string().min(1).max(60),
  required: z.boolean(),
};
const sourceExactActionInputValidationV2Schema = z
  .object({
    minimum: sourceExactDecimalTextV2Schema.optional(),
    maximum: sourceExactDecimalTextV2Schema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined ||
      value.maximum === undefined ||
      exactRangeValid(value.minimum, value.maximum),
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );

export const moduleSourceActionInputV2Schema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("text"),
        validation: z
          .object({
            minimum_length: z.number().int().min(0).optional(),
            maximum_length: z.number().int().positive().optional(),
            pattern: z.string().min(1).max(500).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("formatted_text"),
        validation: z
          .object({
            allowed_blocks: z.array(formattedTextAllowedBlockV2Schema).min(1),
            maximum_length: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("number"),
        validation: z
          .object({
            minimum: z.number().finite().optional(),
            maximum: z.number().finite().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("decimal_number"),
        validation: sourceExactActionInputValidationV2Schema.optional(),
      })
      .strict(),
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("money"),
        validation: sourceExactActionInputValidationV2Schema.optional(),
      })
      .strict(),
    z.object({ ...sourceActionInputBaseV2, type: z.literal("boolean") }).strict(),
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("date"),
        validation: z
          .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("date_time"),
        validation: z
          .object({
            earliest: z.iso.datetime({ offset: true }).optional(),
            latest: z.iso.datetime({ offset: true }).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceActionInputBaseV2,
        type: z.literal("record_reference"),
        record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20),
      })
      .strict(),
    z
      .object({ ...sourceActionInputBaseV2, type: z.literal("organisation_account_reference") })
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

const moduleSourceBodyV1Schema = moduleSourceDocumentSchema.shape.body;
const moduleSourceRecordTypeV1Schema = moduleSourceBodyV1Schema.shape.record_types.element;
const moduleSourceActionV1Schema = moduleSourceBodyV1Schema.shape.actions.element;
const moduleSourceSharingConditionV1Schema =
  moduleSourceBodyV1Schema.shape.sharing_conditions.element;
const moduleSourceSharingParameterV1Schema =
  moduleSourceSharingConditionV1Schema.shape.parameters.element;
const moduleSourceSharingPublicationTestV1Schema =
  moduleSourceSharingConditionV1Schema.shape.publication_tests.element;

const moduleSourceSharingParameterV2Schema = z
  .object({
    ...moduleSourceSharingParameterV1Schema.shape,
    type: z.enum([
      "text",
      "number",
      "decimal_number",
      "money",
      "boolean",
      "date",
      "date_time",
      "organization_account_reference",
    ]),
  })
  .strict();
const moduleSourceSharingPublicationTestV2Schema = z
  .object({ ...moduleSourceSharingPublicationTestV1Schema.shape })
  .strict();
const sourceSharingParameterValueSchema = (
  type: z.infer<typeof moduleSourceSharingParameterV2Schema>["type"],
): z.ZodType => {
  switch (type) {
    case "text":
      return z.string();
    case "number":
      return z.number().finite();
    case "decimal_number":
      return sourceExactDecimalTextV2Schema;
    case "money":
      return sourceMoneyValueV2Schema;
    case "boolean":
      return z.boolean();
    case "date":
      return z.iso.date();
    case "date_time":
      return z.iso.datetime({ offset: true });
    case "organization_account_reference":
      return organizationAccountIdSchema;
  }
};

export const moduleSourceSharingConditionV2Schema = z
  .object({
    ...moduleSourceSharingConditionV1Schema.shape,
    parameters: z.array(moduleSourceSharingParameterV2Schema),
    publication_tests: z.array(moduleSourceSharingPublicationTestV2Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [testIndex, publicationTest] of value.publication_tests.entries())
      for (const parameter of value.parameters)
        if (
          !sourceSharingParameterValueSchema(parameter.type).safeParse(
            publicationTest.parameters[parameter.key],
          ).success
        )
          context.addIssue({
            code: "custom",
            path: ["publication_tests", testIndex, "parameters", parameter.key],
            message: "Publication-test parameter must match its declared V2 type",
          });
  });

export const moduleSourceActionV2Schema = z
  .object({
    ...moduleSourceActionV1Schema.shape,
    inputs: z.array(moduleSourceActionInputV2Schema),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.permission === undefined) === (value.permission_alternatives === undefined))
      context.addIssue({
        code: "custom",
        path: ["permission_alternatives"],
        message: "An action requires either one permission or canonical alternatives",
      });
    const alternatives = value.permission_alternatives;
    if (!alternatives) return;
    if (new Set(alternatives).size !== alternatives.length)
      context.addIssue({
        code: "custom",
        path: ["permission_alternatives"],
        message: "Action permission alternatives must be unique",
      });
    if (
      alternatives.some((permission, index) => index > 0 && alternatives[index - 1]! >= permission)
    )
      context.addIssue({
        code: "custom",
        path: ["permission_alternatives"],
        message: "Action permission alternatives must use canonical order",
      });
  });

export const moduleSourceRecordTypeV2Schema = z
  .object({
    ...moduleSourceRecordTypeV1Schema.shape,
    fields: z.array(moduleSourceFieldV2Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.ownership_mode === "inherited") !== (value.ownership_relationship !== undefined))
      context.addIssue({
        code: "custom",
        path: ["ownership_relationship"],
        message: "Inherited ownership requires exactly one source relationship",
      });
    if (
      value.ownership_relationship !== undefined &&
      !value.fields.some(
        (field) =>
          field.key === value.ownership_relationship &&
          (field.type === "link" || field.type === "link_to_one_of_several"),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["ownership_relationship"],
        message: "The ownership relationship must resolve to a link field on this record type",
      });
  });

export const moduleSourceBodyV2Schema = z
  .object({
    ...moduleSourceBodyV1Schema.shape,
    record_types: z.array(moduleSourceRecordTypeV2Schema).min(1),
    actions: z.array(moduleSourceActionV2Schema),
    sharing_conditions: z.array(moduleSourceSharingConditionV2Schema),
  })
  .strict();

export const moduleSourceDocumentV2Schema = z
  .object({
    ...moduleSourceDocumentSchema.shape,
    source_contract_version: z.literal(moduleSourceContractVersionV2),
    body: moduleSourceBodyV2Schema,
  })
  .strict();

export type ModuleSourceFieldV2 = z.infer<typeof moduleSourceFieldV2Schema>;
export type ModuleSourceRecordTypeV2 = z.infer<typeof moduleSourceRecordTypeV2Schema>;
export type ModuleSourceSharingConditionV2 = z.infer<typeof moduleSourceSharingConditionV2Schema>;
export type ModuleSourceActionInputV2 = z.infer<typeof moduleSourceActionInputV2Schema>;
export type ModuleSourceActionV2 = z.infer<typeof moduleSourceActionV2Schema>;
export type ModuleSourceBodyV2 = z.infer<typeof moduleSourceBodyV2Schema>;
export type ModuleSourceDocumentV2 = z.infer<typeof moduleSourceDocumentV2Schema>;
