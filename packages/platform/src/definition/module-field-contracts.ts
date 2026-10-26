import { flowFormulaSchema, flowFormulaUsesNow } from "../workflows/flow-values";
import { z } from "zod";
import {
  personalDataClassSchema,
  publicDisplaySchema,
  searchPrioritySchema,
} from "../catalogue/catalogues";
import { jsonValueSchema, labelSchema, safeHttpsUrlSchema } from "../catalogue/common";
import { recordTypeReferenceSchema } from "./definitions";
import { parseExactDecimal } from "../records/exact-decimal";
import {
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  permissionIdSchema,
} from "../catalogue/identifiers";
import {
  currencyCodeSchema,
  exactDecimalFitsDigits,
  exactDecimalTextSchema,
  exactDecimalWithinBounds,
  inspectRecordRichText,
  recordLinkValueSchema,
  recordRichTextDocumentSchema,
  type FormattedTextAllowedBlock,
} from "../records/module-field-values";
import { conditionNodeSchema } from "./module-foundation-contracts";

/**
 * The field contract of a module record type: each field type with its settings and default, and
 * the default checks. A records table validates its formatting fields with it in the browser, so it
 * imports nothing beyond the field values it describes.
 */
const optionSchema = z
  .object({
    value: z.string().min(1).max(120),
    label: labelSchema,
    requiredPermissionId: permissionIdSchema.optional(),
  })
  .strict();
const emptySettingsSchema = z.object({}).strict();
const textFormatSchema = z.enum(["uuid"]);
const textSettingsSchema = z
  .object({
    maxLength: z.number().int().min(1).max(100_000),
    format: textFormatSchema.optional(),
  })
  .strict();
const longTextSettingsSchema = z
  .object({ maxLength: z.number().int().min(1).max(1_000_000) })
  .strict();
export const formattedTextAllowedBlockSchema = z.enum([
  "paragraph",
  "heading",
  "list",
  "table",
  "link",
  "attachment",
]);
const formattedTextSettingsSchema = z
  .object({
    allowedBlocks: z.array(formattedTextAllowedBlockSchema).min(1),
    maxLength: z.number().int().positive().optional(),
  })
  .strict();
const wholeNumberSettingsSchema = z
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

export const exactRangeValid = (minimum?: string, maximum?: string): boolean => {
  const parsedMinimum = minimum === undefined ? undefined : parseExactDecimal(minimum);
  const parsedMaximum = maximum === undefined ? undefined : parseExactDecimal(maximum);
  return (
    parsedMinimum !== undefined &&
    parsedMaximum !== undefined &&
    exactDecimalWithinBounds(parsedMinimum, undefined, parsedMaximum)
  );
};

const decimalSettingsSchema = z
  .object({
    digitsBeforeDecimal: z.number().int().min(1).max(30),
    decimalPlaces: z.number().int().min(0).max(12),
    minimum: exactDecimalTextSchema.optional(),
    maximum: exactDecimalTextSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined ||
      value.maximum === undefined ||
      exactRangeValid(value.minimum, value.maximum),
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );
const moneySettingsSchema = z
  .object({
    currencyMode: z.enum(["fixed", "organization_default"]),
    currency: currencyCodeSchema.optional(),
    minimum: exactDecimalTextSchema.optional(),
    maximum: exactDecimalTextSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.currencyMode === "fixed") !== (value.currency !== undefined))
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
const dateSettingsSchema = z
  .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
  .strict();
const dateTimeSettingsSchema = z
  .object({ displayTimeZone: z.enum(["person", "organization", "utc"]).optional() })
  .strict();
const choiceSettingsSchema = z.object({ options: z.array(optionSchema).min(1).max(200) }).strict();
/** A choice field's settings: options may belong to the parent choice option(s) it depends on. */
const choiceFieldSettingsSchema = z
  .object({
    options: z
      .array(
        optionSchema
          .extend({ parentValues: z.array(z.string().min(1).max(120)).min(1).max(200).optional() })
          .strict(),
      )
      .min(1)
      .max(200),
    /** The choice field of this record type whose chosen option narrows this field's options. */
    dependsOn: z.object({ parentFieldId: fieldIdSchema }).strict().optional(),
  })
  .strict();
const severalChoicesSettingsSchema = z
  .object({
    options: z.array(optionSchema).min(1).max(200),
    maximumSelections: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const referenceNumberSettingsSchema = z
  .object({
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    digits: z.number().int().min(1).max(20),
    startingNumber: z.number().int().positive().optional(),
  })
  .strict();
const phoneSettingsSchema = z.object({ defaultCountry: z.string().length(2).optional() }).strict();
const webAddressSettingsSchema = z
  .object({ allowedSchemes: z.array(z.literal("https")).min(1).optional() })
  .strict();

const tableColumnBase = { key: builderKeySchema, required: z.boolean() };
const tableColumnSchema = z.discriminatedUnion("type", [
  z.object({ ...tableColumnBase, type: z.literal("text"), settings: textSettingsSchema }).strict(),
  z
    .object({
      ...tableColumnBase,
      type: z.literal("whole_number"),
      settings: wholeNumberSettingsSchema,
    })
    .strict(),
  z
    .object({
      ...tableColumnBase,
      type: z.literal("decimal_number"),
      settings: decimalSettingsSchema,
    })
    .strict(),
  z
    .object({ ...tableColumnBase, type: z.literal("money"), settings: moneySettingsSchema })
    .strict(),
  z
    .object({ ...tableColumnBase, type: z.literal("yes_no"), settings: emptySettingsSchema })
    .strict(),
  z.object({ ...tableColumnBase, type: z.literal("date"), settings: dateSettingsSchema }).strict(),
  z
    .object({
      ...tableColumnBase,
      type: z.literal("date_time"),
      settings: dateTimeSettingsSchema,
    })
    .strict(),
  z
    .object({ ...tableColumnBase, type: z.literal("choice"), settings: choiceSettingsSchema })
    .strict(),
]);
const tableSettingsSchema = z
  .object({
    minimumRows: z.number().int().min(0),
    maximumRows: z.number().int().min(1).max(1_000),
    columns: z.array(tableColumnSchema).min(1).max(40),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maximumRows < value.minimumRows)
      context.addIssue({
        code: "custom",
        path: ["maximumRows"],
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
const linkSettingsSchema = z
  .object({
    target: recordTypeReferenceSchema,
    reverseKey: builderKeySchema,
    reverseName: labelSchema,
    onParentDelete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
    applicationRootIdRequired: z.boolean().optional(),
    /** The link field of this record type whose chosen record narrows this field's choices. */
    dependsOn: z
      .object({ parentFieldId: fieldIdSchema, filterFieldId: fieldIdSchema })
      .strict()
      .optional(),
  })
  .strict();
const multiLinkSettingsSchema = z
  .object({
    targets: z.array(recordTypeReferenceSchema).min(2).max(20),
    onParentDelete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
/**
 * Whether a calculated field is worked out when the record is read (`read_time`) or stored and
 * refreshed by the owning save (`stored`). The deadline-passed form uses the current time and is
 * therefore always read-time; a stored field may never use the current time. A calculation that
 * uses a read-time calculation is itself read-time, and publication refuses one declared `stored`.
 */
export const moduleCalculationEvaluationSchema = z.enum(["read_time", "stored"]);

const calculationSettingsSchema = z
  .object({
    resultType: z.enum([
      "text",
      "whole_number",
      "decimal_number",
      "money",
      "yes_no",
      "date",
      "date_time",
    ]),
    evaluation: moduleCalculationEvaluationSchema.optional(),
    decimalPlaces: z.number().int().min(0).max(12).optional(),
    expression: flowFormulaSchema,
    dependencyFieldIds: z.array(fieldIdSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.evaluation === "stored" && flowFormulaUsesNow(value.expression))
      context.addIssue({
        code: "custom",
        path: ["evaluation"],
        message: "A deadline-passed calculation uses the current time and is read-time",
      });
    if (
      value.decimalPlaces !== undefined &&
      value.resultType !== "decimal_number" &&
      value.resultType !== "money"
    )
      context.addIssue({
        code: "custom",
        path: ["decimalPlaces"],
        message: "Only decimal and money calculations declare result precision",
      });
  });
const totalSettingsSchema = z
  .object({
    relationshipId: containedComponentIdSchema,
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    resultType: z.enum([
      "text",
      "whole_number",
      "decimal_number",
      "money",
      "yes_no",
      "date",
      "date_time",
    ]),
    fieldId: fieldIdSchema.optional(),
    filter: conditionNodeSchema.optional(),
    currency: currencyCodeSchema.optional(),
    decimalPlaces: z.number().int().min(0).max(12).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decimalPlaces !== undefined && value.operation !== "average")
      context.addIssue({
        code: "custom",
        path: ["decimalPlaces"],
        message: "Only average totals declare result precision",
      });
  });
const attachmentSettingsSchema = z
  .object({
    allowedKinds: z
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
    allowedExtensions: z
      .array(z.string().regex(/^\.[a-z0-9]+$/))
      .min(1)
      .optional(),
    maxFileSizeMb: z.number().positive().max(5_000),
    multiple: z.boolean(),
    maxFiles: z.number().int().min(2).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.multiple !== (value.maxFiles !== undefined))
      context.addIssue({
        code: "custom",
        path: ["maxFiles"],
        message: "maxFiles is required only for a multiple attachment field",
      });
  });

const fieldBase = {
  fieldId: fieldIdSchema,
  key: builderKeySchema,
  label: labelSchema,
  helpText: z.string().max(200).optional(),
  required: z.boolean(),
  unique: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  searchPriority: searchPrioritySchema.optional(),
  personalData: personalDataClassSchema,
  publicDisplay: publicDisplaySchema,
};
const moduleFieldMember = <K extends string, S extends z.ZodType, D extends z.ZodType>(
  type: K,
  settings: S,
  defaultValue: D,
) =>
  z
    .object({ ...fieldBase, type: z.literal(type), settings, default: defaultValue.optional() })
    .strict();
const noDefaultSchema = z.never();
const tableDefaultSchema = z.array(z.record(builderKeySchema, jsonValueSchema));
const fieldMembers = [
  moduleFieldMember("text", textSettingsSchema, z.string()),
  moduleFieldMember("long_text", longTextSettingsSchema, z.string()),
  moduleFieldMember("formatted_text", formattedTextSettingsSchema, recordRichTextDocumentSchema),
  moduleFieldMember("whole_number", wholeNumberSettingsSchema, z.number().int()),
  moduleFieldMember("decimal_number", decimalSettingsSchema, exactDecimalTextSchema),
  moduleFieldMember("money", moneySettingsSchema, exactDecimalTextSchema),
  moduleFieldMember("yes_no", emptySettingsSchema, z.boolean()),
  moduleFieldMember("date", dateSettingsSchema, z.iso.date()),
  moduleFieldMember("date_time", dateTimeSettingsSchema, z.iso.datetime({ offset: true })),
  moduleFieldMember("choice", choiceFieldSettingsSchema, z.string()),
  moduleFieldMember("several_choices", severalChoicesSettingsSchema, z.array(z.string())),
  moduleFieldMember("reference_number", referenceNumberSettingsSchema, noDefaultSchema),
  moduleFieldMember("email_address", emptySettingsSchema, z.email()),
  moduleFieldMember("phone_number", phoneSettingsSchema, z.string()),
  moduleFieldMember("web_address", webAddressSettingsSchema, safeHttpsUrlSchema),
  moduleFieldMember("table", tableSettingsSchema, tableDefaultSchema),
  moduleFieldMember("link", linkSettingsSchema, recordLinkValueSchema),
  moduleFieldMember("link_to_one_of_several", multiLinkSettingsSchema, recordLinkValueSchema),
  moduleFieldMember("calculation", calculationSettingsSchema, noDefaultSchema),
  moduleFieldMember("total", totalSettingsSchema, noDefaultSchema),
  moduleFieldMember("attachment", attachmentSettingsSchema, noDefaultSchema),
] as const;

const textFormatValid = (format: z.infer<typeof textFormatSchema> | undefined, value: string) =>
  format === undefined || (format === "uuid" && z.uuid().safeParse(value).success);
const wholeNumberValid = (value: number, settings: z.infer<typeof wholeNumberSettingsSchema>) =>
  (settings.minimum === undefined || value >= settings.minimum) &&
  (settings.maximum === undefined || value <= settings.maximum) &&
  (settings.step === undefined || (value - (settings.minimum ?? 0)) % settings.step === 0);
const decimalValid = (value: string, settings: z.infer<typeof decimalSettingsSchema>) => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return (
    exactDecimalFitsDigits(parsed, settings.digitsBeforeDecimal, settings.decimalPlaces) &&
    exactDecimalWithinBounds(
      parsed,
      settings.minimum === undefined ? undefined : parseExactDecimal(settings.minimum),
      settings.maximum === undefined ? undefined : parseExactDecimal(settings.maximum),
    )
  );
};
const moneyAmountValid = (value: string, settings: z.infer<typeof moneySettingsSchema>) => {
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
  settings: z.infer<typeof formattedTextSettingsSchema>,
) => {
  const inspected = inspectRecordRichText(value);
  const allowed = new Set<FormattedTextAllowedBlock>(settings.allowedBlocks);
  return (
    [...inspected.usedBlocks].every((kind) => allowed.has(kind)) &&
    (settings.maxLength === undefined || inspected.visibleTextLength <= settings.maxLength)
  );
};
const tableCellDefaultValid = (
  column: z.infer<typeof tableColumnSchema>,
  value: unknown,
): boolean => {
  switch (column.type) {
    case "text":
      return (
        typeof value === "string" &&
        value.length <= column.settings.maxLength &&
        textFormatValid(column.settings.format, value)
      );
    case "whole_number":
      return Number.isInteger(value) && wholeNumberValid(value as number, column.settings);
    case "decimal_number":
      return (
        exactDecimalTextSchema.safeParse(value).success &&
        decimalValid(value as string, column.settings)
      );
    case "money":
      return (
        exactDecimalTextSchema.safeParse(value).success &&
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
  settings: z.infer<typeof tableSettingsSchema>,
) => {
  const keys = new Set(settings.columns.map((column) => column.key));
  return (
    value.length >= settings.minimumRows &&
    value.length <= settings.maximumRows &&
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

export const moduleFieldSchema = z
  .discriminatedUnion("type", fieldMembers)
  .superRefine((value, context) => {
    if (value.default === undefined) return;
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", path: ["default"], message });
    switch (value.type) {
      case "text":
        if (
          value.default.length > value.settings.maxLength ||
          !textFormatValid(value.settings.format, value.default)
        )
          invalid("Default must match the text length and format settings");
        break;
      case "long_text":
        if (value.default.length > value.settings.maxLength)
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
          invalid("Default must be one published choice");
        break;
      case "several_choices":
        if (
          !value.default.every((item) =>
            value.settings.options.some((option) => option.value === item),
          ) ||
          (value.settings.maximumSelections !== undefined &&
            value.default.length > value.settings.maximumSelections)
        )
          invalid("Every default must be one published choice within the selection limit");
        break;
      case "table":
        if (!tableDefaultValid(value.default, value.settings))
          invalid("Default must match the configured table columns and row limits");
        break;
      case "link":
        if (
          value.settings.target.state === "resolved" &&
          value.default.recordTypeId !== value.settings.target.recordTypeId
        )
          invalid("Default record type must match the configured link target");
        break;
      case "link_to_one_of_several":
        if (
          value.settings.targets.every((target) => target.state === "resolved") &&
          !value.settings.targets.some(
            (target) => target.recordTypeId === value.default!.recordTypeId,
          )
        )
          invalid("Default record type must be one configured link target");
        break;
      case "yes_no":
      case "date_time":
      case "email_address":
      case "phone_number":
      case "web_address":
        break;
    }
  });

export type ModuleField = z.infer<typeof moduleFieldSchema>;
