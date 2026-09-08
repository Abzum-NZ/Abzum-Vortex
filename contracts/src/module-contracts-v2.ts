import { z } from "zod";
import { personalDataClassSchema, publicDisplaySchema, searchPrioritySchema } from "./catalogues";
import { jsonValueSchema, labelSchema, safeHttpsUrlSchema } from "./common";
import { recordTypeReferenceSchema } from "./definitions";
import { parseExactDecimal } from "./exact-decimal";
import {
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  organizationAccountIdSchema,
  permissionIdSchema,
} from "./identifiers";
import {
  currencyCodeV2Schema,
  exactDecimalFitsDigitsV2,
  exactDecimalTextV2Schema,
  exactDecimalWithinBoundsV2,
  inspectRecordRichTextV2,
  personLinkValueV2Schema,
  recordLinkValueV2Schema,
  recordRichTextDocumentV2Schema,
  type FormattedTextAllowedBlockV2,
} from "./module-field-values-v2";
import {
  actionDefinitionSchema,
  conditionNodeSchema,
  moduleContentSchema,
  recordTypeDefinitionSchema,
  savedSharingConditionSchema,
} from "./module-contracts";
import { moduleDefinitionEnvelopeSchema } from "./definitions";
import { moduleSourceContractVersionV2 } from "./module-source-contracts-v2";

export const moduleValidationContractVersionV2 = "2.0.0" as const;

/** A standalone candidate pair; Definition dispatch does not consume it yet. */
export const moduleContractVersionPairV2Schema = z
  .object({
    sourceContractVersion: z.literal(moduleSourceContractVersionV2),
    validationContractVersion: z.literal(moduleValidationContractVersionV2),
  })
  .strict();

const optionV2Schema = z
  .object({
    value: z.string().min(1).max(120),
    label: labelSchema,
    requiredPermissionId: permissionIdSchema.optional(),
  })
  .strict();
const emptySettingsSchema = z.object({}).strict();
const textFormatV2Schema = z.enum(["email_address", "web_address", "uuid"]);
const textSettingsV2Schema = z
  .object({
    maxLength: z.number().int().min(1).max(100_000),
    format: textFormatV2Schema.optional(),
  })
  .strict();
const longTextSettingsV2Schema = z
  .object({ maxLength: z.number().int().min(1).max(1_000_000) })
  .strict();
const formattedTextAllowedBlockV2Schema = z.enum([
  "paragraph",
  "heading",
  "list",
  "table",
  "link",
  "attachment",
]);
const formattedTextSettingsV2Schema = z
  .object({
    allowedBlocks: z.array(formattedTextAllowedBlockV2Schema).min(1),
    maxLength: z.number().int().positive().optional(),
  })
  .strict();
const wholeNumberSettingsV2Schema = z
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

const decimalSettingsV2Schema = z
  .object({
    digitsBeforeDecimal: z.number().int().min(1).max(30),
    decimalPlaces: z.number().int().min(0).max(12),
    minimum: exactDecimalTextV2Schema.optional(),
    maximum: exactDecimalTextV2Schema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined ||
      value.maximum === undefined ||
      exactRangeValid(value.minimum, value.maximum),
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );
const moneySettingsV2Schema = z
  .object({
    currencyMode: z.enum(["fixed", "organization_default"]),
    currency: currencyCodeV2Schema.optional(),
    minimum: exactDecimalTextV2Schema.optional(),
    maximum: exactDecimalTextV2Schema.optional(),
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
const dateSettingsV2Schema = z
  .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
  .strict();
const dateTimeSettingsV2Schema = z
  .object({ displayTimeZone: z.enum(["person", "organization", "utc"]).optional() })
  .strict();
const choiceSettingsV2Schema = z
  .object({ options: z.array(optionV2Schema).min(1).max(200) })
  .strict();
const severalChoicesSettingsV2Schema = z
  .object({
    options: z.array(optionV2Schema).min(1).max(200),
    maximumSelections: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const referenceNumberSettingsV2Schema = z
  .object({
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    digits: z.number().int().min(1).max(20),
    startingNumber: z.number().int().positive().optional(),
  })
  .strict();
const phoneSettingsV2Schema = z
  .object({ defaultCountry: z.string().length(2).optional() })
  .strict();
const webAddressSettingsV2Schema = z
  .object({ allowedSchemes: z.array(z.literal("https")).min(1).optional() })
  .strict();

const tableColumnBase = { key: builderKeySchema, required: z.boolean() };
const tableColumnV2Schema = z.discriminatedUnion("type", [
  z
    .object({ ...tableColumnBase, type: z.literal("text"), settings: textSettingsV2Schema })
    .strict(),
  z
    .object({
      ...tableColumnBase,
      type: z.literal("whole_number"),
      settings: wholeNumberSettingsV2Schema,
    })
    .strict(),
  z
    .object({
      ...tableColumnBase,
      type: z.literal("decimal_number"),
      settings: decimalSettingsV2Schema,
    })
    .strict(),
  z
    .object({ ...tableColumnBase, type: z.literal("money"), settings: moneySettingsV2Schema })
    .strict(),
  z
    .object({ ...tableColumnBase, type: z.literal("yes_no"), settings: emptySettingsSchema })
    .strict(),
  z
    .object({ ...tableColumnBase, type: z.literal("date"), settings: dateSettingsV2Schema })
    .strict(),
  z
    .object({
      ...tableColumnBase,
      type: z.literal("date_time"),
      settings: dateTimeSettingsV2Schema,
    })
    .strict(),
  z
    .object({ ...tableColumnBase, type: z.literal("choice"), settings: choiceSettingsV2Schema })
    .strict(),
]);
const tableSettingsV2Schema = z
  .object({
    minimumRows: z.number().int().min(0),
    maximumRows: z.number().int().min(1).max(1_000),
    columns: z.array(tableColumnV2Schema).min(1).max(40),
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
const linkSettingsV2Schema = z
  .object({
    target: recordTypeReferenceSchema,
    reverseKey: builderKeySchema,
    onParentDelete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const multiLinkSettingsV2Schema = z
  .object({
    targets: z.array(recordTypeReferenceSchema).min(2).max(20),
    onParentDelete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const personLinkSettingsV2Schema = z
  .object({
    audience: z.enum([
      "organization_accounts",
      "application_accounts",
      "organization_identities_and_external_requesters",
    ]),
    applicationRootIdRequired: z.boolean(),
    onPersonDeactivation: z.enum(["retain_reference", "empty_optional", "refuse_deactivation"]),
  })
  .strict();
const calculationNumberOperandV2Schema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("literal"), value: exactDecimalTextV2Schema }).strict(),
]);
const calculationExpressionV2Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("join_text"),
      fieldIds: z.array(fieldIdSchema).min(1).max(20),
      separator: z.string().max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("numeric"),
      operation: z.enum(["add", "subtract", "multiply", "divide"]),
      operands: z.array(calculationNumberOperandV2Schema).min(2).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("subtract_percentage"),
      amountFieldId: fieldIdSchema,
      percentageFieldId: fieldIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("condition"), condition: conditionNodeSchema }).strict(),
  z
    .object({
      kind: z.literal("date_offset"),
      dateFieldId: fieldIdSchema,
      amount: calculationNumberOperandV2Schema,
      unit: z.enum(["days", "weeks", "months", "years"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deadline_passed"),
      dueFieldId: fieldIdSchema,
      statusFieldId: fieldIdSchema.optional(),
      terminalStatusValues: z.array(jsonValueSchema).max(20),
    })
    .strict(),
]);
const calculationSettingsV2Schema = z
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
    expression: calculationExpressionV2Schema,
    dependencyFieldIds: z.array(fieldIdSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.expression.kind === "join_text" && value.resultType === "text") ||
      (value.expression.kind === "condition" && value.resultType === "yes_no") ||
      (value.expression.kind === "date_offset" &&
        (value.resultType === "date" || value.resultType === "date_time")) ||
      (value.expression.kind === "deadline_passed" && value.resultType === "yes_no") ||
      ((value.expression.kind === "numeric" || value.expression.kind === "subtract_percentage") &&
        (value.resultType === "whole_number" ||
          value.resultType === "decimal_number" ||
          value.resultType === "money"));
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["resultType"],
        message: "Calculation result type must match its closed expression kind",
      });
  });
const totalSettingsV2Schema = z
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
    currency: currencyCodeV2Schema.optional(),
  })
  .strict();
const attachmentSettingsV2Schema = z
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

const fieldBaseV2 = {
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
const fieldV2 = <K extends string, S extends z.ZodType, D extends z.ZodType>(
  type: K,
  settings: S,
  defaultValue: D,
) =>
  z
    .object({ ...fieldBaseV2, type: z.literal(type), settings, default: defaultValue.optional() })
    .strict();
const noDefaultSchema = z.never();
const tableDefaultV2Schema = z.array(z.record(builderKeySchema, jsonValueSchema));
const fieldMembersV2 = [
  fieldV2("text", textSettingsV2Schema, z.string()),
  fieldV2("long_text", longTextSettingsV2Schema, z.string()),
  fieldV2("formatted_text", formattedTextSettingsV2Schema, recordRichTextDocumentV2Schema),
  fieldV2("whole_number", wholeNumberSettingsV2Schema, z.number().int()),
  fieldV2("decimal_number", decimalSettingsV2Schema, exactDecimalTextV2Schema),
  fieldV2("money", moneySettingsV2Schema, exactDecimalTextV2Schema),
  fieldV2("yes_no", emptySettingsSchema, z.boolean()),
  fieldV2("date", dateSettingsV2Schema, z.iso.date()),
  fieldV2("date_time", dateTimeSettingsV2Schema, z.iso.datetime({ offset: true })),
  fieldV2("choice", choiceSettingsV2Schema, z.string()),
  fieldV2("several_choices", severalChoicesSettingsV2Schema, z.array(z.string())),
  fieldV2("reference_number", referenceNumberSettingsV2Schema, noDefaultSchema),
  fieldV2("email_address", emptySettingsSchema, z.email()),
  fieldV2("phone_number", phoneSettingsV2Schema, z.string()),
  fieldV2("web_address", webAddressSettingsV2Schema, safeHttpsUrlSchema),
  fieldV2("table", tableSettingsV2Schema, tableDefaultV2Schema),
  fieldV2("link", linkSettingsV2Schema, recordLinkValueV2Schema),
  fieldV2("link_to_one_of_several", multiLinkSettingsV2Schema, recordLinkValueV2Schema),
  fieldV2("link_to_person", personLinkSettingsV2Schema, personLinkValueV2Schema),
  fieldV2("calculation", calculationSettingsV2Schema, noDefaultSchema),
  fieldV2("total", totalSettingsV2Schema, noDefaultSchema),
  fieldV2("attachment", attachmentSettingsV2Schema, noDefaultSchema),
] as const;

const textFormatValid = (format: z.infer<typeof textFormatV2Schema> | undefined, value: string) =>
  format === undefined ||
  (format === "email_address" && z.email().safeParse(value).success) ||
  (format === "web_address" && safeHttpsUrlSchema.safeParse(value).success) ||
  (format === "uuid" && z.uuid().safeParse(value).success);
const wholeNumberValid = (value: number, settings: z.infer<typeof wholeNumberSettingsV2Schema>) =>
  (settings.minimum === undefined || value >= settings.minimum) &&
  (settings.maximum === undefined || value <= settings.maximum) &&
  (settings.step === undefined || (value - (settings.minimum ?? 0)) % settings.step === 0);
const decimalValid = (value: string, settings: z.infer<typeof decimalSettingsV2Schema>) => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return (
    exactDecimalFitsDigitsV2(parsed, settings.digitsBeforeDecimal, settings.decimalPlaces) &&
    exactDecimalWithinBoundsV2(
      parsed,
      settings.minimum === undefined ? undefined : parseExactDecimal(settings.minimum),
      settings.maximum === undefined ? undefined : parseExactDecimal(settings.maximum),
    )
  );
};
const moneyAmountValid = (value: string, settings: z.infer<typeof moneySettingsV2Schema>) => {
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
  settings: z.infer<typeof formattedTextSettingsV2Schema>,
) => {
  const inspected = inspectRecordRichTextV2(value);
  const allowed = new Set<FormattedTextAllowedBlockV2>(settings.allowedBlocks);
  return (
    [...inspected.usedBlocks].every((kind) => allowed.has(kind)) &&
    (settings.maxLength === undefined || inspected.visibleTextLength <= settings.maxLength)
  );
};
const tableCellDefaultValid = (
  column: z.infer<typeof tableColumnV2Schema>,
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
        exactDecimalTextV2Schema.safeParse(value).success &&
        decimalValid(value as string, column.settings)
      );
    case "money":
      return (
        exactDecimalTextV2Schema.safeParse(value).success &&
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
  settings: z.infer<typeof tableSettingsV2Schema>,
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

export const moduleFieldV2Schema = z
  .discriminatedUnion("type", fieldMembersV2)
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
      case "link_to_person":
        break;
    }
  });

const actionInputBaseV2 = {
  key: builderKeySchema,
  label: labelSchema,
  required: z.boolean(),
};
const exactActionInputValidationV2Schema = z
  .object({
    minimum: exactDecimalTextV2Schema.optional(),
    maximum: exactDecimalTextV2Schema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined ||
      value.maximum === undefined ||
      exactRangeValid(value.minimum, value.maximum),
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );

export const actionInputDefinitionV2Schema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...actionInputBaseV2,
        type: z.literal("text"),
        validation: z
          .object({
            minimumLength: z.number().int().min(0).optional(),
            maximumLength: z.number().int().positive().optional(),
            pattern: z.string().min(1).max(500).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionInputBaseV2,
        type: z.literal("formatted_text"),
        validation: z
          .object({
            allowedBlocks: z.array(formattedTextAllowedBlockV2Schema).min(1),
            maximumLength: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionInputBaseV2,
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
        ...actionInputBaseV2,
        type: z.literal("decimal_number"),
        validation: exactActionInputValidationV2Schema.optional(),
      })
      .strict(),
    z
      .object({
        ...actionInputBaseV2,
        type: z.literal("money"),
        validation: exactActionInputValidationV2Schema.optional(),
      })
      .strict(),
    z.object({ ...actionInputBaseV2, type: z.literal("boolean") }).strict(),
    z
      .object({
        ...actionInputBaseV2,
        type: z.literal("date"),
        validation: z
          .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionInputBaseV2,
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
        ...actionInputBaseV2,
        type: z.literal("record_reference"),
        recordTypes: z.array(recordTypeReferenceSchema).min(1).max(20),
      })
      .strict(),
    z.object({ ...actionInputBaseV2, type: z.literal("organization_account_reference") }).strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.type === "text" &&
      value.validation?.minimumLength !== undefined &&
      value.validation.maximumLength !== undefined &&
      value.validation.minimumLength > value.validation.maximumLength
    )
      context.addIssue({
        code: "custom",
        path: ["validation", "maximumLength"],
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

export const actionDefinitionV2Schema = z
  .object({
    ...actionDefinitionSchema.shape,
    inputs: z.array(actionInputDefinitionV2Schema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.permissionKey === undefined) === (value.permissionKeys === undefined))
      context.addIssue({
        code: "custom",
        path: ["permissionKeys"],
        message: "An action requires either one permission or canonical alternatives",
      });
    if (value.permissionKeys) {
      if (new Set(value.permissionKeys).size !== value.permissionKeys.length)
        context.addIssue({
          code: "custom",
          path: ["permissionKeys"],
          message: "Action permission alternatives must be unique",
        });
      if (
        value.permissionKeys.some(
          (permission, index) => index > 0 && value.permissionKeys![index - 1]! >= permission,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["permissionKeys"],
          message: "Action permission alternatives must use canonical order",
        });
    }
    if (new Set(value.inputs.map((input) => input.key)).size !== value.inputs.length)
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "Action input keys must be unique",
      });
  });

export const recordTypeDefinitionV2Schema = z
  .object({
    ...recordTypeDefinitionSchema.shape,
    fields: z.array(moduleFieldV2Schema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.ownershipMode === "inherited") !== (value.ownershipRelationshipId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["ownershipRelationshipId"],
        message: "Inherited ownership requires exactly one relationship",
      });
    if (
      value.ownershipRelationshipId !== undefined &&
      !value.relationships.some(
        (relationship) =>
          relationship.relationshipId === value.ownershipRelationshipId &&
          relationship.fromRecordTypeId === value.recordTypeId,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["ownershipRelationshipId"],
        message: "Inherited ownership relationship must belong to this record type",
      });
    if (!value.fields.some((field) => field.fieldId === value.titleFieldId))
      context.addIssue({
        code: "custom",
        path: ["titleFieldId"],
        message: "Title field must belong to the record type",
      });
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const [index, item] of value.fields.entries()) {
      if (ids.has(item.fieldId))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "fieldId"],
          message: "Field identity is duplicated",
        });
      if (keys.has(item.key))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "key"],
          message: "Field key is duplicated",
        });
      ids.add(item.fieldId);
      keys.add(item.key);
    }
  });

const sharingConditionParameterV1Schema = savedSharingConditionSchema.shape.parameters.element;
const sharingConditionPublicationTestV1Schema =
  savedSharingConditionSchema.shape.publicationTests.element;
const sharingConditionParameterV2Schema = z
  .object({
    ...sharingConditionParameterV1Schema.shape,
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
const sharingConditionPublicationTestV2Schema = z
  .object({ ...sharingConditionPublicationTestV1Schema.shape })
  .strict();
const sharingParameterValueSchema = (
  type: z.infer<typeof sharingConditionParameterV2Schema>["type"],
): z.ZodType => {
  switch (type) {
    case "text":
      return z.string();
    case "number":
      return z.number().finite();
    case "decimal_number":
      return exactDecimalTextV2Schema;
    case "money":
      return z
        .object({ amount: exactDecimalTextV2Schema, currency: currencyCodeV2Schema })
        .strict();
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

export const savedSharingConditionV2Schema = z
  .object({
    ...savedSharingConditionSchema.shape,
    parameters: z.array(sharingConditionParameterV2Schema),
    publicationTests: z.array(sharingConditionPublicationTestV2Schema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [testIndex, publicationTest] of value.publicationTests.entries())
      for (const parameter of value.parameters)
        if (
          !sharingParameterValueSchema(parameter.type).safeParse(
            publicationTest.parameters[parameter.key],
          ).success
        )
          context.addIssue({
            code: "custom",
            path: ["publicationTests", testIndex, "parameters", parameter.key],
            message: "Publication-test parameter must match its declared V2 type",
          });
  });

export const moduleContentV2Schema = z
  .object({
    ...moduleContentSchema.shape,
    recordTypes: z.array(recordTypeDefinitionV2Schema).min(1).max(100),
    actions: z.array(actionDefinitionV2Schema),
    sharingConditions: z.array(savedSharingConditionV2Schema),
  })
  .strict();

export const moduleDraftV2Schema = z
  .object({ envelope: moduleDefinitionEnvelopeSchema, content: moduleContentV2Schema })
  .strict();

/** Standalone V2 canonical content is not part of Definition dispatch or publication yet. */
export const moduleCanonicalDocumentV2Schema = z
  .object({
    validationContractVersion: z.literal(moduleValidationContractVersionV2),
    canonical: moduleDraftV2Schema,
  })
  .strict();

export type ModuleContractVersionPairV2 = z.infer<typeof moduleContractVersionPairV2Schema>;
export type ModuleFieldV2 = z.infer<typeof moduleFieldV2Schema>;
export type ActionInputDefinitionV2 = z.infer<typeof actionInputDefinitionV2Schema>;
export type ActionDefinitionV2 = z.infer<typeof actionDefinitionV2Schema>;
export type RecordTypeDefinitionV2 = z.infer<typeof recordTypeDefinitionV2Schema>;
export type SavedSharingConditionV2 = z.infer<typeof savedSharingConditionV2Schema>;
export type ModuleContentV2 = z.infer<typeof moduleContentV2Schema>;
export type ModuleDraftV2 = z.infer<typeof moduleDraftV2Schema>;
export type ModuleCanonicalDocumentV2 = z.infer<typeof moduleCanonicalDocumentV2Schema>;
