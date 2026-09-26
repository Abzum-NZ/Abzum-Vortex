import { z } from "zod";
import {
  actionInputValueTypes,
  personalDataClassSchema,
  publicDisplaySchema,
  searchPrioritySchema,
  sharingParameterValueTypeV2Schema,
} from "./catalogues";
import {
  calculationMaximumNestingDepth,
  calculationMaximumOperandCount,
  jsonValueSchema,
  labelSchema,
  safeHttpsUrlSchema,
} from "./common";
import { moduleDefinitionEnvelopeSchema, recordTypeReferenceSchema } from "./definitions";
import { parseExactDecimal } from "./exact-decimal";
import {
  actionIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  permissionIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
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
  actionTaskSchema,
  conditionNodeSchema,
  eventDefinitionSchema,
  moduleDependencySchema,
  relationshipDefinitionSchema,
} from "./module-contracts";
import { moduleSourceContractVersion as moduleSourceContractVersionV3 } from "./module-source-contracts";
import { permissionDeclarationSchema } from "./permissions";
import { protectedOperationReferenceSchema } from "./application-flow-bindings";
import { PLATFORM_SERVICE_OPERATIONS } from "./platform-service-operation-catalogue";
import { protectedReadModelKeySchema } from "./application-composition-v2";
import { flowSchema } from "./flow-contracts";
import { recordOwnershipModeSchema } from "./record-ownership-compatibility";
import { ruleGraphSchema } from "./rule-graph-contracts";

export const moduleValidationContractVersionV3 = "3.0.0" as const;

/** The one current Module source/validation contract pair. */
export const moduleContractVersionPairV3Schema = z
  .object({
    sourceContractVersion: z.literal(moduleSourceContractVersionV3),
    validationContractVersion: z.literal(moduleValidationContractVersionV3),
  })
  .strict();

const optionSchema = z
  .object({
    value: z.string().min(1).max(120),
    label: labelSchema,
    requiredPermissionId: permissionIdSchema.optional(),
  })
  .strict();
const emptySettingsSchema = z.object({}).strict();
const textFormatSchema = z.enum(["email_address", "web_address", "uuid"]);
const textSettingsSchema = z
  .object({
    maxLength: z.number().int().min(1).max(100_000),
    format: textFormatSchema.optional(),
  })
  .strict();
const longTextSettingsSchema = z
  .object({ maxLength: z.number().int().min(1).max(1_000_000) })
  .strict();
const formattedTextAllowedBlockSchema = z.enum([
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

const exactRangeValid = (minimum?: string, maximum?: string): boolean => {
  const parsedMinimum = minimum === undefined ? undefined : parseExactDecimal(minimum);
  const parsedMaximum = maximum === undefined ? undefined : parseExactDecimal(maximum);
  return (
    parsedMinimum !== undefined &&
    parsedMaximum !== undefined &&
    exactDecimalWithinBoundsV2(parsedMinimum, undefined, parsedMaximum)
  );
};

const decimalSettingsSchema = z
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
const moneySettingsSchema = z
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
const dateSettingsSchema = z
  .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
  .strict();
const dateTimeSettingsSchema = z
  .object({ displayTimeZone: z.enum(["person", "organization", "utc"]).optional() })
  .strict();
const choiceSettingsSchema = z
  .object({ options: z.array(optionSchema).min(1).max(200) })
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
const phoneSettingsSchema = z
  .object({ defaultCountry: z.string().length(2).optional() })
  .strict();
const webAddressSettingsSchema = z
  .object({ allowedSchemes: z.array(z.literal("https")).min(1).optional() })
  .strict();

const tableColumnBase = { key: builderKeySchema, required: z.boolean() };
const tableColumnSchema = z.discriminatedUnion("type", [
  z
    .object({ ...tableColumnBase, type: z.literal("text"), settings: textSettingsSchema })
    .strict(),
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
  z
    .object({ ...tableColumnBase, type: z.literal("date"), settings: dateSettingsSchema })
    .strict(),
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
    onParentDelete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const multiLinkSettingsSchema = z
  .object({
    targets: z.array(recordTypeReferenceSchema).min(2).max(20),
    onParentDelete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const personLinkSettingsSchema = z
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
/** A named field or one exact decimal literal. A date offset takes only these. */
const calculationNumberOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("literal"), value: exactDecimalTextV2Schema }).strict(),
]);
const calculationNumberOperationSchema = z.enum(["add", "subtract", "multiply", "divide"]);
type CalculationNumberOperationV3 = z.infer<typeof calculationNumberOperationSchema>;
/**
 * One value of a numeric calculation: a named field, an exact decimal literal, or a further
 * numeric operation over further values. A nested operation is the same closed form the
 * calculation itself uses, so a new formula needs no new expression kind and no engine change.
 */
type CalculationNumberValueV3 =
  | z.infer<typeof calculationNumberOperandSchema>
  | {
      source: "numeric";
      operation: CalculationNumberOperationV3;
      operands: CalculationNumberValueV3[];
    };
const inspectCalculationNumberValueV3 = (
  value: CalculationNumberValueV3,
  depth = 1,
): { depth: number; values: number } => {
  if (value.source !== "numeric") return { depth, values: 1 };
  const inspected = value.operands.map((operand) =>
    inspectCalculationNumberValueV3(operand, depth + 1),
  );
  return {
    depth: Math.max(depth, ...inspected.map((operand) => operand.depth)),
    values: 1 + inspected.reduce((total, operand) => total + operand.values, 0),
  };
};
const calculationNumberValueSchema: z.ZodType<CalculationNumberValueV3> = z.lazy(() =>
  z
    .discriminatedUnion("source", [
      ...calculationNumberOperandSchema.options,
      z
        .object({
          source: z.literal("numeric"),
          operation: calculationNumberOperationSchema,
          operands: z.array(calculationNumberValueSchema).min(2).max(20),
        })
        .strict(),
    ])
    .superRefine((value, context) => {
      const inspected = inspectCalculationNumberValueV3(value);
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
const calculationExpressionSchema = z.discriminatedUnion("kind", [
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
      operation: calculationNumberOperationSchema,
      operands: z.array(calculationNumberValueSchema).min(2).max(20),
    })
    .strict(),
  z.object({ kind: z.literal("condition"), condition: conditionNodeSchema }).strict(),
  z
    .object({
      kind: z.literal("date_offset"),
      dateFieldId: fieldIdSchema,
      amount: calculationNumberOperandSchema,
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
/**
 * Whether a calculated field is worked out when the record is read (`read_time`) or stored and
 * refreshed by the owning save (`stored`). The deadline-passed form uses the current time and is
 * therefore always read-time; a stored field may never use the current time. A calculation that
 * uses a read-time calculation is itself read-time, and publication refuses one declared `stored`.
 */
export const moduleCalculationEvaluationV3Schema = z.enum(["read_time", "stored"]);

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
    evaluation: moduleCalculationEvaluationV3Schema.optional(),
    decimalPlaces: z.number().int().min(0).max(12).optional(),
    expression: calculationExpressionSchema,
    dependencyFieldIds: z.array(fieldIdSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.evaluation === "stored" && value.expression.kind === "deadline_passed")
      context.addIssue({
        code: "custom",
        path: ["evaluation"],
        message: "A deadline-passed calculation uses the current time and is read-time",
      });
    const valid =
      (value.expression.kind === "join_text" && value.resultType === "text") ||
      (value.expression.kind === "condition" && value.resultType === "yes_no") ||
      (value.expression.kind === "date_offset" &&
        (value.resultType === "date" || value.resultType === "date_time")) ||
      (value.expression.kind === "deadline_passed" && value.resultType === "yes_no") ||
      (value.expression.kind === "numeric" &&
        (value.resultType === "whole_number" ||
          value.resultType === "decimal_number" ||
          value.resultType === "money"));
    if (
      value.expression.kind === "numeric" &&
      value.expression.operands.reduce(
        (total, operand) => total + inspectCalculationNumberValueV3(operand).values,
        0,
      ) > calculationMaximumOperandCount
    )
      context.addIssue({
        code: "custom",
        path: ["expression", "operands"],
        message: `A numeric calculation cannot exceed ${calculationMaximumOperandCount} values`,
      });
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["resultType"],
        message: "Calculation result type must match its closed expression kind",
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
    currency: currencyCodeV2Schema.optional(),
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
  moduleFieldMember("formatted_text", formattedTextSettingsSchema, recordRichTextDocumentV2Schema),
  moduleFieldMember("whole_number", wholeNumberSettingsSchema, z.number().int()),
  moduleFieldMember("decimal_number", decimalSettingsSchema, exactDecimalTextV2Schema),
  moduleFieldMember("money", moneySettingsSchema, exactDecimalTextV2Schema),
  moduleFieldMember("yes_no", emptySettingsSchema, z.boolean()),
  moduleFieldMember("date", dateSettingsSchema, z.iso.date()),
  moduleFieldMember("date_time", dateTimeSettingsSchema, z.iso.datetime({ offset: true })),
  moduleFieldMember("choice", choiceSettingsSchema, z.string()),
  moduleFieldMember("several_choices", severalChoicesSettingsSchema, z.array(z.string())),
  moduleFieldMember("reference_number", referenceNumberSettingsSchema, noDefaultSchema),
  moduleFieldMember("email_address", emptySettingsSchema, z.email()),
  moduleFieldMember("phone_number", phoneSettingsSchema, z.string()),
  moduleFieldMember("web_address", webAddressSettingsSchema, safeHttpsUrlSchema),
  moduleFieldMember("table", tableSettingsSchema, tableDefaultSchema),
  moduleFieldMember("link", linkSettingsSchema, recordLinkValueV2Schema),
  moduleFieldMember("link_to_one_of_several", multiLinkSettingsSchema, recordLinkValueV2Schema),
  moduleFieldMember("link_to_person", personLinkSettingsSchema, personLinkValueV2Schema),
  moduleFieldMember("calculation", calculationSettingsSchema, noDefaultSchema),
  moduleFieldMember("total", totalSettingsSchema, noDefaultSchema),
  moduleFieldMember("attachment", attachmentSettingsSchema, noDefaultSchema),
] as const;

const textFormatValid = (format: z.infer<typeof textFormatSchema> | undefined, value: string) =>
  format === undefined ||
  (format === "email_address" && z.email().safeParse(value).success) ||
  (format === "web_address" && safeHttpsUrlSchema.safeParse(value).success) ||
  (format === "uuid" && z.uuid().safeParse(value).success);
const wholeNumberValid = (value: number, settings: z.infer<typeof wholeNumberSettingsSchema>) =>
  (settings.minimum === undefined || value >= settings.minimum) &&
  (settings.maximum === undefined || value <= settings.maximum) &&
  (settings.step === undefined || (value - (settings.minimum ?? 0)) % settings.step === 0);
const decimalValid = (value: string, settings: z.infer<typeof decimalSettingsSchema>) => {
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
const moneyAmountValid = (value: string, settings: z.infer<typeof moneySettingsSchema>) => {
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
  settings: z.infer<typeof formattedTextSettingsSchema>,
) => {
  const inspected = inspectRecordRichTextV2(value);
  const allowed = new Set<FormattedTextAllowedBlockV2>(settings.allowedBlocks);
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

export const moduleFieldV3Schema = z
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
      case "link_to_person":
        break;
    }
  });

const actionInputBase = {
  key: builderKeySchema,
  label: labelSchema,
  required: z.boolean(),
};
const exactActionInputValidationSchema = z
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

export const actionInputDefinitionV3Schema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.text),
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
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.formatted_text),
        validation: z
          .object({
            allowedBlocks: z.array(formattedTextAllowedBlockSchema).min(1),
            maximumLength: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.number),
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
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.decimal_number),
        validation: exactActionInputValidationSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.money),
        validation: exactActionInputValidationSchema.optional(),
      })
      .strict(),
    z.object({ ...actionInputBase, type: z.literal(actionInputValueTypes.boolean) }).strict(),
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.date),
        validation: z
          .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.date_time),
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
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.record_reference),
        recordTypes: z.array(recordTypeReferenceSchema).min(1).max(20),
      })
      .strict(),
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.organization_account_reference),
      })
      .strict(),
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

const sharingConditionParameterSchema = z
  .object({ key: builderKeySchema, type: sharingParameterValueTypeV2Schema })
  .strict();
const sharingConditionPublicationTestSchema = z
  .object({
    name: labelSchema,
    parameters: z.record(builderKeySchema, jsonValueSchema),
    fieldValues: z.record(fieldIdSchema, jsonValueSchema),
    expected: z.boolean(),
  })
  .strict();
const sharingParameterValueSchema = (
  type: z.infer<typeof sharingConditionParameterSchema>["type"],
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

export const savedSharingConditionV3Schema = z
  .object({
    conditionId: containedComponentIdSchema,
    sourceRecordTypeId: recordTypeIdSchema,
    key: builderKeySchema,
    publishedRevision: revisionSchema,
    contractFingerprint: fingerprintSchema,
    parameters: z.array(sharingConditionParameterSchema),
    condition: conditionNodeSchema,
    declaredFieldIds: z.array(fieldIdSchema),
    publicationTests: z.array(sharingConditionPublicationTestSchema).min(1),
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
            message: "Publication-test parameter must match its declared type",
          });
  });

export const moduleQuerySortSchema = z
  .object({
    fieldId: fieldIdSchema,
    direction: z.enum(["ascending", "descending"]),
  })
  .strict();

export const moduleQueryAggregateSchema = z
  .object({
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    fieldId: fieldIdSchema.optional(),
    alias: builderKeySchema,
  })
  .strict();

/**
 * One Module-owned named query declaration. It is the same closed query contract an
 * Application already publishes, extended with typed inputs and owned by a stable query
 * identity inside an exact Module release. It never carries SQL or a database target.
 */
export const moduleQueryDefinitionV3Schema = z
  .object({
    queryId: queryIdSchema,
    key: builderKeySchema,
    label: z.string().min(1).max(60).optional(),
    description: z.string().min(1).max(1_000).optional(),
    recordType: recordTypeReferenceSchema,
    inputs: z.array(actionInputDefinitionV3Schema).max(50),
    selectedFieldIds: z.array(fieldIdSchema).min(1).max(200),
    filter: conditionNodeSchema.nullable().optional(),
    groupByFieldIds: z.array(fieldIdSchema).max(10),
    aggregates: z.array(moduleQueryAggregateSchema).max(20),
    sort: z.array(moduleQuerySortSchema).min(1).max(20),
    pageSize: z.number().int().min(1).max(200),
    relationshipHops: z.number().int().min(0).max(2),
  })
  .strict();

/**
 * One Module-owned declaration that a component from this Module adds itself to an
 * extension point declared by a dependency. The contributed field or action keeps its
 * existing permanent identity, which is also the contribution's stable identity. The
 * target module is the exact resolved dependency entry, never a fresh reference.
 */
export const moduleContributionV3Schema = z
  .object({
    contributionId: containedComponentIdSchema,
    targetModule: moduleDependencySchema,
    targetExtensionPointId: containedComponentIdSchema,
    kind: z.enum(["field", "action"]),
    recordTypeId: recordTypeIdSchema.optional(),
    fieldId: fieldIdSchema.optional(),
    actionId: actionIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const invalid = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: "custom", path, message });
    if (value.kind === "field") {
      if (
        value.actionId !== undefined ||
        value.recordTypeId === undefined ||
        value.fieldId === undefined
      )
        invalid("A field contribution declares exactly its contributing record type and field", [
          "fieldId",
        ]);
      else if (String(value.contributionId) !== String(value.fieldId))
        invalid("A field contribution is identified by its contributed field", ["contributionId"]);
      return;
    }
    if (value.fieldId !== undefined || value.recordTypeId !== undefined || value.actionId === undefined)
      invalid("An action contribution declares exactly its contributing action", ["actionId"]);
    else if (String(value.contributionId) !== String(value.actionId))
      invalid("An action contribution is identified by its contributed action", [
        "contributionId",
      ]);
  });

/**
 * The canonical system projection storage kind: the record type's typed fields project one
 * registered protected view and are read through the one query path. The canonical form resolves
 * the organisation field, the revision field and the declared filterable and sortable fields to
 * their permanent field identities.
 */
export const moduleSystemProjectionV3Schema = z
  .object({
    protectedView: protectedReadModelKeySchema,
    organizationFieldId: fieldIdSchema,
    revisionFieldId: fieldIdSchema,
    filterableFieldIds: z.array(fieldIdSchema).max(500),
    sortableFieldIds: z.array(fieldIdSchema).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.filterableFieldIds).size !== value.filterableFieldIds.length)
      context.addIssue({
        code: "custom",
        path: ["filterableFieldIds"],
        message: "Filterable field identities must be unique",
      });
    if (new Set(value.sortableFieldIds).size !== value.sortableFieldIds.length)
      context.addIssue({
        code: "custom",
        path: ["sortableFieldIds"],
        message: "Sortable field identities must be unique",
      });
  });

/**
 * Field types whose values come from generated record storage rather than a column of a protected
 * view, which a system projection record type cannot declare (the source contract refuses the same).
 */
const systemProjectionRefusedFieldTypes: ReadonlySet<string> = new Set([
  "reference_number",
  "table",
  "link",
  "link_to_one_of_several",
  "total",
  "attachment",
]);

/**
 * A canonical Module record type. A generated-table record type carries no `systemProjection`. A
 * system projection record type is organisation scoped, refuses every standard write action, holds a
 * required text organisation field and a required whole-number revision field, and its declared
 * filterable and sortable fields are exactly its fields flagged filterable and sortable.
 */
export const recordTypeDefinitionV3Schema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    key: builderKeySchema,
    singularLabel: labelSchema,
    pluralLabel: labelSchema,
    titleFieldId: fieldIdSchema,
    storageContractId: storageContractIdSchema,
    storageScope: z.enum(["organization_shared", "application_contained"]),
    ownershipMode: recordOwnershipModeSchema,
    ownershipRelationshipId: containedComponentIdSchema.optional(),
    fields: z.array(moduleFieldV3Schema).min(1).max(500),
    relationships: z.array(relationshipDefinitionSchema),
    standardActions: z
      .array(z.enum(["create", "read", "update", "soft_delete", "restore", "export"]))
      .min(1),
    customActionIds: z.array(actionIdSchema),
    systemProjection: moduleSystemProjectionV3Schema.optional(),
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
  })
  .superRefine((value, context) => {
    const projection = value.systemProjection;
    if (projection === undefined) return;
    const invalid = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: "custom", path, message });
    if (value.storageScope !== "organization_shared")
      invalid("A system projection record type is scoped to exactly one organisation", [
        "storageScope",
      ]);
    if (
      value.standardActions.some(
        (action) =>
          action === "create" ||
          action === "update" ||
          action === "soft_delete" ||
          action === "restore",
      )
    )
      invalid("System projection record types refuse standard create, update, delete and restore", [
        "standardActions",
      ]);
    const fields = new Map(value.fields.map((field) => [String(field.fieldId), field]));
    const organization = fields.get(String(projection.organizationFieldId));
    if (organization === undefined || organization.type !== "text" || !organization.required)
      invalid("The organisation field must be a required text field of the record type", [
        "systemProjection",
        "organizationFieldId",
      ]);
    const revision = fields.get(String(projection.revisionFieldId));
    if (revision === undefined || revision.type !== "whole_number" || !revision.required)
      invalid("The revision field must be a required whole-number field of the record type", [
        "systemProjection",
        "revisionFieldId",
      ]);
    for (const [index, field] of value.fields.entries())
      if (systemProjectionRefusedFieldTypes.has(field.type))
        invalid("A system projection field is a read-only value of its protected view", [
          "fields",
          index,
          "type",
        ]);
    const filterable = new Set(projection.filterableFieldIds.map(String));
    const sortable = new Set(projection.sortableFieldIds.map(String));
    for (const [index, fieldId] of projection.filterableFieldIds.entries())
      if (!fields.get(String(fieldId))?.filterable)
        invalid("A declared filterable field must be a filterable field of the record type", [
          "systemProjection",
          "filterableFieldIds",
          index,
        ]);
    for (const [index, fieldId] of projection.sortableFieldIds.entries())
      if (!fields.get(String(fieldId))?.sortable)
        invalid("A declared sortable field must be a sortable field of the record type", [
          "systemProjection",
          "sortableFieldIds",
          index,
        ]);
    for (const [index, field] of value.fields.entries()) {
      if (field.filterable && !filterable.has(String(field.fieldId)))
        invalid("Every filterable system projection field must be declared filterable", [
          "fields",
          index,
          "filterable",
        ]);
      if (field.sortable && !sortable.has(String(field.fieldId)))
        invalid("Every sortable system projection field must be declared sortable", [
          "fields",
          index,
          "sortable",
        ]);
    }
  });

/**
 * Whether a canonical protected-operation reference names a registered platform-service operation
 * that changes one existing row at an expected revision: the only operations a system projection
 * record type action may target, so the subject row's identity and revision always have somewhere
 * to go. A Module- or application-owned operation is never a system record write path.
 */
export const isSystemRecordProtectedOperation = (
  reference: z.infer<typeof protectedOperationReferenceSchema>,
): boolean => {
  const owner = reference.owner;
  return (
    owner.kind === "platform_service" &&
    Object.values(PLATFORM_SERVICE_OPERATIONS).some(
      (operation) =>
        operation.release.serviceId === owner.serviceId &&
        operation.release.operationId === reference.operationId &&
        operation.descriptor.expectedRevision === "required",
    )
  );
};

/**
 * A canonical Module action. An action orders effects or targets one registered protected operation,
 * never both. A protected-operation action declares no effects and no identity or revision inputs,
 * because the subject record's identity and revision reach the operation automatically when it
 * runs. It needs both its own permission and the operation's registered permission: the operation
 * re-checks the actor's current authority in its owning service and never accepts an organisation
 * or actor.
 */
export const actionDefinitionV3Schema = z
  .object({
    actionId: actionIdSchema,
    key: namespacedKeySchema,
    label: labelSchema,
    subjectRecordTypeId: recordTypeIdSchema,
    permissionKey: namespacedKeySchema.optional(),
    permissionKeys: z.array(namespacedKeySchema).min(2).optional(),
    sharing: z.enum(["refused", "allowed"]),
    inputs: z.array(actionInputDefinitionV3Schema).max(50),
    precondition: conditionNodeSchema.optional(),
    tasks: z.array(actionTaskSchema).max(10),
    protectedOperation: protectedOperationReferenceSchema.optional(),
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
  })
  .superRefine((value, context) => {
    const operation = value.protectedOperation;
    if ((operation !== undefined) === value.tasks.length > 0)
      context.addIssue({
        code: "custom",
        path: ["protectedOperation"],
        message: "An action targets either ordered tasks or one registered protected operation",
      });
    if (operation !== undefined && !isSystemRecordProtectedOperation(operation))
      context.addIssue({
        code: "custom",
        path: ["protectedOperation"],
        message: "An action targets a registered platform-service operation on one existing row",
      });
  });

/**
 * A Module's canonical content. `flows` is the one home of its behaviour (architecture decision 1):
 * every save rule is a flow with a `BeforeSave` trigger and `transaction` execution.
 *
 * `rules` is not authored. It is the executable form of exactly those `BeforeSave` flows, derived
 * from them by the compiler, because the database read that hands a save its rules and the
 * before-save evaluator still read a rule graph. Until the flow interpreter replaces them (#1007),
 * every `BeforeSave` flow has exactly one rule of the same identity, record type and priority, and
 * no rule exists without its flow, so a save can never run without a rule its Module declares.
 */
export const moduleContentV3Schema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    dependencies: z.array(moduleDependencySchema),
    recordTypes: z.array(recordTypeDefinitionV3Schema).min(1).max(100),
    permissions: z.array(permissionDeclarationSchema),
    actions: z.array(actionDefinitionV3Schema),
    events: z.array(eventDefinitionSchema),
    sharingConditions: z.array(savedSharingConditionV3Schema),
    extensionPoints: z.array(
      z
        .object({
          extensionPointId: containedComponentIdSchema,
          key: builderKeySchema,
          recordTypeId: recordTypeIdSchema,
          accepts: z.array(z.enum(["field", "action", "choice_option", "link_target"])).min(1),
        })
        .strict(),
    ),
    flows: z.array(flowSchema).max(100),
    rules: z.array(ruleGraphSchema).max(100),
    queries: z.array(moduleQueryDefinitionV3Schema).max(100).default([]),
    contributions: z.array(moduleContributionV3Schema).max(100).optional(),
  })
  .strict();

export const moduleDraftV3Schema = z
  .object({ envelope: moduleDefinitionEnvelopeSchema, content: moduleContentV3Schema })
  .strict()
  .superRefine((draft, context) => {
    const invalid = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: "custom", path: ["content", ...path], message });
    const flowIds = new Set<string>();
    const flowKeys = new Set<string>();
    draft.content.flows.forEach((flow, index) => {
      if (flowIds.has(flow.id)) invalid("Flow identities must be unique", ["flows", index, "id"]);
      if (flowKeys.has(flow.key)) invalid("Flow keys must be unique", ["flows", index, "key"]);
      flowIds.add(flow.id);
      flowKeys.add(flow.key);
    });
    const beforeSave = new Map(
      draft.content.flows.flatMap((flow) =>
        flow.triggers.some((trigger) => trigger.type === "BeforeSave")
          ? [[String(flow.id), flow] as const]
          : [],
      ),
    );
    const ruleIds = new Set<string>();
    draft.content.rules.forEach((rule, index) => {
      ruleIds.add(String(rule.ruleId));
      const flow = beforeSave.get(String(rule.ruleId));
      const trigger = flow?.triggers[0];
      if (
        flow === undefined ||
        flow.triggers.length !== 1 ||
        trigger?.type !== "BeforeSave" ||
        trigger.recordTypeId !== rule.subjectRecordTypeId ||
        trigger.priority !== rule.priority ||
        flow.key !== rule.key
      )
        invalid("A rule is the executable form of exactly one BeforeSave flow", ["rules", index]);
    });
    for (const flowId of beforeSave.keys())
      if (!ruleIds.has(flowId))
        invalid("Every BeforeSave flow needs its executable rule", [
          "flows",
          draft.content.flows.findIndex((flow) => String(flow.id) === flowId),
        ]);
    // A system projection record type has no ordinary write path, so every action on it targets a
    // registered protected operation, and no other record type's action may target one.
    const projections = new Set(
      draft.content.recordTypes.flatMap((recordType) =>
        recordType.systemProjection === undefined ? [] : [String(recordType.recordTypeId)],
      ),
    );
    draft.content.actions.forEach((action, index) => {
      if (
        projections.has(String(action.subjectRecordTypeId)) !==
        (action.protectedOperation !== undefined)
      )
        invalid(
          "Exactly the actions of a system projection record type target a protected operation",
          ["actions", index, "protectedOperation"],
        );
    });
  });

export const moduleCanonicalDocumentV3Schema = z
  .object({
    validationContractVersion: z.literal(moduleValidationContractVersionV3),
    canonical: moduleDraftV3Schema,
  })
  .strict();

export type ModuleContractVersionPairV3 = z.infer<typeof moduleContractVersionPairV3Schema>;
export type ModuleFieldV3 = z.infer<typeof moduleFieldV3Schema>;
export type ActionInputDefinitionV3 = z.infer<typeof actionInputDefinitionV3Schema>;
export type SavedSharingConditionV3 = z.infer<typeof savedSharingConditionV3Schema>;
export type ModuleQuerySort = z.infer<typeof moduleQuerySortSchema>;
export type ModuleQueryAggregate = z.infer<typeof moduleQueryAggregateSchema>;
export type ModuleQueryDefinitionV3 = z.infer<typeof moduleQueryDefinitionV3Schema>;
export type ModuleSystemProjectionV3 = z.infer<typeof moduleSystemProjectionV3Schema>;
export type RecordTypeDefinitionV3 = z.infer<typeof recordTypeDefinitionV3Schema>;
export type ActionDefinitionV3 = z.infer<typeof actionDefinitionV3Schema>;
export type ModuleContributionV3 = z.infer<typeof moduleContributionV3Schema>;
export type ModuleContentV3 = z.infer<typeof moduleContentV3Schema>;
export type ModuleDraftV3 = z.infer<typeof moduleDraftV3Schema>;
export type ModuleCanonicalDocumentV3 = z.infer<typeof moduleCanonicalDocumentV3Schema>;
