import { z } from "zod";
import { personalDataClassSchema, publicDisplaySchema, searchPrioritySchema } from "./catalogues";
import { builderKeySchema, namespacedKeySchema, organizationAccountIdSchema } from "./identifiers";
import { jsonValueSchema, labelSchema, safeHttpsUrlSchema } from "./common";
import { versionRequirementSchema } from "./definitions";
import {
  authoredSourceBase,
  sourceActionEffectSchema,
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedRecordTypeSchema,
  sourceQualifiedRelationshipSchema,
} from "./definition-source-common";
import { parseExactDecimal } from "./exact-decimal";
import {
  currencyCodeV2Schema,
  exactDecimalFitsDigitsV2,
  exactDecimalWithinBoundsV2,
  inspectRecordRichTextV2,
  recordRichTextDocumentV2Schema,
  sourceExactDecimalTextV2Schema,
  sourceMoneyValueV2Schema,
  sourcePersonLinkValueV2Schema,
  sourceRecordLinkValueV2Schema,
  type FormattedTextAllowedBlockV2,
} from "./module-field-values-v2";
import { moduleSourceRecordOwnershipModeSchema } from "./record-ownership-compatibility";
import { sourceRuleGraphSchema } from "./rule-graph-source-contracts";

/** The one current Module source/validation contract pair. */
export const moduleSourceContractVersion = "3.0.0" as const;

const maximumSourceDocumentNodes = 50_000;
const maximumSourceNestingDepth = 32;
const maximumSourceContainerItems = 1_000;
const maximumSourceStringLength = 1_000_000;

const inspectSourceBounds = (value: unknown, context: z.RefinementCtx) => {
  const pending: {
    value: unknown;
    path: (string | number)[];
    depth: number;
    exit?: object;
  }[] = [{ value, path: [], depth: 0 }];
  const ancestors = new Set<object>();
  let visited = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (entry.exit !== undefined) {
      ancestors.delete(entry.exit);
      continue;
    }
    visited += 1;
    if (visited > maximumSourceDocumentNodes) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source document is too large",
      });
      return z.NEVER;
    }
    if (entry.depth > maximumSourceNestingDepth) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source nesting is too deep",
      });
      return z.NEVER;
    }
    if (typeof entry.value === "string" && entry.value.length > maximumSourceStringLength) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source text is too long",
      });
      return z.NEVER;
    }
    if (typeof entry.value !== "object" || entry.value === null) continue;
    if (ancestors.has(entry.value)) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source values must be acyclic",
      });
      return z.NEVER;
    }
    if (
      Array.isArray(entry.value) &&
      entry.value.length > maximumSourceContainerItems
    ) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source container has too many items",
      });
      return z.NEVER;
    }
    const children = Array.isArray(entry.value)
      ? entry.value.map((child, index) => [index, child] as const)
      : Object.entries(entry.value);
    if (!Array.isArray(entry.value) && children.length > maximumSourceContainerItems) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source container has too many items",
      });
      return z.NEVER;
    }
    ancestors.add(entry.value);
    pending.push({ value: undefined, path: [], depth: 0, exit: entry.value });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const [key, child] = children[index]!;
      pending.push({ value: child, path: [...entry.path, key], depth: entry.depth + 1 });
    }
  }
  return value;
};

// ---------------------------------------------------------------------------
// Shared permission plumbing. Application source contracts import these
// directly; their shape is not versioned per Module generation.
// ---------------------------------------------------------------------------

export const sourcePermissionRecordScopeRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all_records") }).strict(),
  z.object({ kind: z.literal("ownership") }).strict(),
  z.object({ kind: z.literal("direct_share") }).strict(),
  z
    .object({
      kind: z.literal("relationship"),
      relationship: sourceQualifiedRelationshipSchema,
      source_permission: namespacedKeySchema,
    })
    .strict(),
]);

const sourceRecordScopeRouteIdentity = (
  route: z.infer<typeof sourcePermissionRecordScopeRouteSchema>,
) =>
  route.kind === "relationship"
    ? `${route.kind}:${route.relationship}:${route.source_permission}`
    : route.kind;

export const sourcePermissionRecordScopeBaseSchema = z
  .object({ routes: z.array(sourcePermissionRecordScopeRouteSchema).min(1).max(100) })
  .strict()
  .superRefine((value, context) => {
    const identities = value.routes.map(sourceRecordScopeRouteIdentity);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Permission record-scope routes must be unique",
      });
    if (value.routes.some((route) => route.kind === "all_records") && value.routes.length !== 1)
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "The all-record route must be the sole base route",
      });
  });

const sourceSavedConditionParameterBindingSchema = z.discriminatedUnion("source", [
  z
    .object({
      key: builderKeySchema,
      source: z.literal("current_organization_account_id"),
    })
    .strict(),
  z
    .object({ key: builderKeySchema, source: z.literal("literal"), value: jsonValueSchema })
    .strict(),
]);

export const moduleSourcePermissionRecordScopeSchema =
  sourcePermissionRecordScopeBaseSchema.safeExtend({
    saved_condition: z
      .object({
        condition: builderKeySchema,
        parameter_bindings: z.array(sourceSavedConditionParameterBindingSchema),
      })
      .strict()
      .optional(),
  });

export const sourcePermissionFieldPolicySchema = z
  .object({
    readable_fields: z.array(builderKeySchema).max(500),
    changeable_fields: z.array(builderKeySchema).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.readable_fields).size !== value.readable_fields.length)
      context.addIssue({
        code: "custom",
        path: ["readable_fields"],
        message: "Readable field aliases must be unique",
      });
    if (new Set(value.changeable_fields).size !== value.changeable_fields.length)
      context.addIssue({
        code: "custom",
        path: ["changeable_fields"],
        message: "Changeable field aliases must be unique",
      });
    const readable = new Set(value.readable_fields);
    if (value.changeable_fields.some((field) => !readable.has(field)))
      context.addIssue({
        code: "custom",
        path: ["changeable_fields"],
        message: "Changeable fields must be a readable subset",
      });
  });

// ---------------------------------------------------------------------------
// Shared action-input contract. Application source contracts import this
// directly; it deliberately excludes the exact decimal_number/money input
// types Module actions add below, so its shape stays fixed across Modules.
// ---------------------------------------------------------------------------

const sourceSharedActionInputBase = {
  key: builderKeySchema,
  label: labelSchema,
  required: z.boolean(),
};

export const actionInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...sourceSharedActionInputBase,
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
        ...sourceSharedActionInputBase,
        type: z.literal("formatted_text"),
        validation: z
          .object({
            allowed_blocks: z
              .array(z.enum(["paragraph", "heading", "list", "link", "attachment"]))
              .min(1),
            maximum_length: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
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
    z.object({ ...sourceSharedActionInputBase, type: z.literal("boolean") }).strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: z.literal("date"),
        validation: z
          .object({
            earliest: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            latest: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: z.literal("date_time"),
        validation: z
          .object({
            earliest: z.string().datetime({ offset: true }).optional(),
            latest: z.string().datetime({ offset: true }).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: z.literal("record_reference"),
        record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: z.literal("organisation_account_reference"),
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

// ---------------------------------------------------------------------------
// Module field catalogue (current: exact-decimal text at every numeric
// boundary, complete typed table columns).
// ---------------------------------------------------------------------------

const sourceOptionSchema = z
  .object({
    value: z.string().min(1).max(120),
    label: labelSchema,
    required_permission: namespacedKeySchema.optional(),
  })
  .strict();
const emptySettingsSchema = z.object({}).strict();
const sourceTextFormatSchema = z.enum(["email_address", "web_address", "uuid"]);
const sourceTextSettingsSchema = z
  .object({
    max_length: z.number().int().min(1).max(100_000),
    format: sourceTextFormatSchema.optional(),
  })
  .strict();
const sourceLongTextSettingsSchema = z
  .object({ max_length: z.number().int().min(1).max(1_000_000) })
  .strict();
const formattedTextAllowedBlockSchema = z.enum([
  "paragraph",
  "heading",
  "list",
  "table",
  "link",
  "attachment",
]);
const sourceFormattedTextSettingsSchema = z
  .object({
    allowed_blocks: z.array(formattedTextAllowedBlockSchema).min(1),
    max_length: z.number().int().positive().optional(),
  })
  .strict();
const sourceWholeNumberSettingsSchema = z
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

const sourceDecimalSettingsSchema = z
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
const sourceMoneySettingsSchema = z
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
const sourceDateSettingsSchema = z
  .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
  .strict();
const sourceDateTimeSettingsSchema = z
  .object({ display_time_zone: z.enum(["person", "organisation", "utc"]).optional() })
  .strict();
const sourceChoiceSettingsSchema = z
  .object({ options: z.array(sourceOptionSchema).min(1).max(200) })
  .strict();
const sourceSeveralChoicesSettingsSchema = z
  .object({
    options: z.array(sourceOptionSchema).min(1).max(200),
    maximum_selections: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const sourceReferenceNumberSettingsSchema = z
  .object({
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    digits: z.number().int().min(1).max(20),
    starting_number: z.number().int().positive().optional(),
  })
  .strict();
const sourcePhoneSettingsSchema = z
  .object({ default_country: z.string().length(2).optional() })
  .strict();
const sourceWebAddressSettingsSchema = z
  .object({ allowed_schemes: z.array(z.literal("https")).min(1).optional() })
  .strict();

const sourceTableColumnBase = { key: builderKeySchema, required: z.boolean() };
const sourceTableColumnSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("text"),
      settings: sourceTextSettingsSchema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("whole_number"),
      settings: sourceWholeNumberSettingsSchema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("decimal_number"),
      settings: sourceDecimalSettingsSchema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("money"),
      settings: sourceMoneySettingsSchema,
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
      settings: sourceDateSettingsSchema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("date_time"),
      settings: sourceDateTimeSettingsSchema,
    })
    .strict(),
  z
    .object({
      ...sourceTableColumnBase,
      type: z.literal("choice"),
      settings: sourceChoiceSettingsSchema,
    })
    .strict(),
]);
const sourceTableSettingsSchema = z
  .object({
    minimum_rows: z.number().int().min(0),
    maximum_rows: z.number().int().min(1).max(1_000),
    columns: z.array(sourceTableColumnSchema).min(1).max(40),
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
    target: sourceQualifiedRecordTypeSchema,
    reverse_key: builderKeySchema,
    on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const sourceMultiLinkSettingsSchema = z
  .object({
    targets: z.array(sourceQualifiedRecordTypeSchema).min(2).max(20),
    on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
  })
  .strict();
const sourcePersonLinkSettingsSchema = z
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

const sourceCalculationNumberOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("literal"), value: sourceExactDecimalTextV2Schema }).strict(),
]);
const sourceCalculationExpressionSchema = z.discriminatedUnion("operation", [
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
      operands: z.array(sourceCalculationNumberOperandSchema).min(2).max(20),
    })
    .strict(),
  z.object({ operation: z.literal("condition"), condition: sourceConditionSchema }).strict(),
  z
    .object({
      operation: z.literal("date_offset"),
      date_field: builderKeySchema,
      amount: sourceCalculationNumberOperandSchema,
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
const sourceCalculationSettingsSchema = z
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
    expression: sourceCalculationExpressionSchema,
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
const sourceTotalSettingsSchema = z
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
const sourceAttachmentSettingsSchema = z
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

const sourceFieldBase = {
  id: sourceAliasSchema,
  key: builderKeySchema,
  label: labelSchema,
  help_text: z.string().max(200).optional(),
  required: z.boolean(),
  unique: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  search_priority: searchPrioritySchema.optional(),
  personal_data: personalDataClassSchema,
  public_display: publicDisplaySchema,
};
const sourceField = <K extends string, S extends z.ZodType, D extends z.ZodType>(
  type: K,
  settings: S,
  defaultValue: D,
) =>
  z
    .object({
      ...sourceFieldBase,
      type: z.literal(type),
      settings,
      default: defaultValue.optional(),
    })
    .strict();
const noDefaultSchema = z.never();
const sourceTableDefaultSchema = z.array(z.record(builderKeySchema, jsonValueSchema)).max(1_000);

const sourceFieldMembers = [
  sourceField("text", sourceTextSettingsSchema, z.string()),
  sourceField("long_text", sourceLongTextSettingsSchema, z.string()),
  sourceField("formatted_text", sourceFormattedTextSettingsSchema, recordRichTextDocumentV2Schema),
  sourceField("whole_number", sourceWholeNumberSettingsSchema, z.number().int()),
  sourceField("decimal_number", sourceDecimalSettingsSchema, sourceExactDecimalTextV2Schema),
  sourceField("money", sourceMoneySettingsSchema, sourceExactDecimalTextV2Schema),
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
  sourceField("link", sourceLinkSettingsSchema, sourceRecordLinkValueV2Schema),
  sourceField(
    "link_to_one_of_several",
    sourceMultiLinkSettingsSchema,
    sourceRecordLinkValueV2Schema,
  ),
  sourceField("link_to_person", sourcePersonLinkSettingsSchema, sourcePersonLinkValueV2Schema),
  sourceField("calculation", sourceCalculationSettingsSchema, noDefaultSchema),
  sourceField("total", sourceTotalSettingsSchema, noDefaultSchema),
  sourceField("attachment", sourceAttachmentSettingsSchema, noDefaultSchema),
] as const;

const textFormatValid = (
  format: z.infer<typeof sourceTextFormatSchema> | undefined,
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
  settings: z.infer<typeof sourceWholeNumberSettingsSchema>,
) =>
  (settings.minimum === undefined || value >= settings.minimum) &&
  (settings.maximum === undefined || value <= settings.maximum) &&
  (settings.step === undefined || (value - (settings.minimum ?? 0)) % settings.step === 0);
const decimalValid = (value: string, settings: z.infer<typeof sourceDecimalSettingsSchema>) => {
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
const moneyAmountValid = (value: string, settings: z.infer<typeof sourceMoneySettingsSchema>) => {
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
  settings: z.infer<typeof sourceFormattedTextSettingsSchema>,
) => {
  const inspected = inspectRecordRichTextV2(value);
  const allowed = new Set<FormattedTextAllowedBlockV2>(settings.allowed_blocks);
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

// ---------------------------------------------------------------------------
// Module-only action inputs. Modules additionally accept exact decimal_number
// and money inputs; the shared actionInputSchema above does not.
// ---------------------------------------------------------------------------

const moduleSourceActionInputBase = {
  key: builderKeySchema,
  label: labelSchema,
  required: z.boolean(),
};
const moduleSourceExactActionInputValidationSchema = z
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

export const moduleSourceActionInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...moduleSourceActionInputBase,
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
        ...moduleSourceActionInputBase,
        type: z.literal("formatted_text"),
        validation: z
          .object({
            allowed_blocks: z.array(formattedTextAllowedBlockSchema).min(1),
            maximum_length: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
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
        ...moduleSourceActionInputBase,
        type: z.literal("decimal_number"),
        validation: moduleSourceExactActionInputValidationSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: z.literal("money"),
        validation: moduleSourceExactActionInputValidationSchema.optional(),
      })
      .strict(),
    z.object({ ...moduleSourceActionInputBase, type: z.literal("boolean") }).strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
        type: z.literal("date"),
        validation: z
          .object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...moduleSourceActionInputBase,
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
        ...moduleSourceActionInputBase,
        type: z.literal("record_reference"),
        record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20),
      })
      .strict(),
    z
      .object({ ...moduleSourceActionInputBase, type: z.literal("organisation_account_reference") })
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

// ---------------------------------------------------------------------------
// Record types, actions and sharing conditions.
// ---------------------------------------------------------------------------

export const moduleSourceRecordTypeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    name: labelSchema,
    plural_name: labelSchema,
    title_field: builderKeySchema,
    storage_contract_id: sourceAliasSchema,
    storage_scope: z.enum(["organisation_shared", "application_contained"]),
    ownership_mode: moduleSourceRecordOwnershipModeSchema,
    ownership_relationship: builderKeySchema.optional(),
    standard_actions: z
      .array(z.enum(["create", "read", "update", "soft_delete", "restore", "export"]))
      .min(1)
      .max(6),
    custom_actions: z.array(sourceAliasSchema).max(100),
    fields: z.array(moduleSourceFieldSchema).min(1).max(500),
    relationships: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          from_field: builderKeySchema,
          to_record_type: sourceQualifiedRecordTypeSchema.optional(),
          to_record_types: z.array(sourceQualifiedRecordTypeSchema).min(2).max(20).optional(),
          cardinality: z.enum(["one_to_one", "many_to_one", "many_to_many"]),
          on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
        })
        .strict()
        .refine(
          (value) => (value.to_record_type !== undefined) !== (value.to_record_types !== undefined),
          { message: "Declare one target or a polymorphic target list" },
        ),
    ).max(500),
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

export const moduleSourceActionSchema = z
  .object({
    id: sourceAliasSchema,
    key: namespacedKeySchema,
    label: labelSchema,
    record_type: builderKeySchema,
    permission: namespacedKeySchema.optional(),
    permission_alternatives: z.array(namespacedKeySchema).min(2).optional(),
    shareable: z.boolean(),
    inputs: z.array(moduleSourceActionInputSchema).max(100),
    precondition: sourceConditionSchema.optional(),
    effects: z.array(sourceActionEffectSchema).min(1).max(10),
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

const moduleSourceSharingParameterSchema = z
  .object({
    key: builderKeySchema,
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
const moduleSourceSharingPublicationTestSchema = z
  .object({
    name: labelSchema,
    parameters: z.record(builderKeySchema, jsonValueSchema),
    field_values: z.record(builderKeySchema, jsonValueSchema),
    expected: z.boolean(),
  })
  .strict();
const sourceSharingParameterValueSchema = (
  type: z.infer<typeof moduleSourceSharingParameterSchema>["type"],
): z.ZodType => sourceSharingParameterValueSchemas[type];
const sourceSharingParameterValueSchemas: Record<
  z.infer<typeof moduleSourceSharingParameterSchema>["type"],
  z.ZodType
> = {
  text: z.string(),
  number: z.number().finite(),
  decimal_number: sourceExactDecimalTextV2Schema,
  money: sourceMoneyValueV2Schema,
  boolean: z.boolean(),
  date: z.iso.date(),
  date_time: z.iso.datetime({ offset: true }),
  organization_account_reference: organizationAccountIdSchema,
};

export const moduleSourceSharingConditionSchema = z
  .object({
    id: sourceAliasSchema,
    source_record_type: builderKeySchema,
    key: builderKeySchema,
    parameters: z.array(moduleSourceSharingParameterSchema).max(100),
    condition: sourceConditionSchema,
    declared_fields: z.array(builderKeySchema).max(500),
    publication_tests: z.array(moduleSourceSharingPublicationTestSchema).min(1).max(100),
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
            message: "Publication-test parameter must match its declared parameter type",
          });
  });

// ---------------------------------------------------------------------------
// Module queries.
// ---------------------------------------------------------------------------

export const moduleSourceQuerySortSchema = z
  .object({
    field: builderKeySchema,
    direction: z.enum(["ascending", "descending"]),
  })
  .strict();

export const moduleSourceQueryAggregateSchema = z
  .object({
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    field: builderKeySchema.optional(),
    alias: builderKeySchema,
  })
  .strict();

/**
 * One authored Module-owned query. It names a local or dependency-qualified record type,
 * typed inputs, the fields it returns, a typed filter tree, grouping, totals, a stable sort,
 * a bounded page size and its declared relationship hops. It never carries a database target.
 */
export const moduleSourceQuerySchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    label: labelSchema.optional(),
    description: z.string().min(1).max(1_000).optional(),
    record_type: z.union([builderKeySchema, sourceQualifiedRecordTypeSchema]),
    inputs: z.array(moduleSourceActionInputSchema).max(50),
    select: z.array(builderKeySchema).min(1).max(200),
    filter: z.union([z.null(), sourceConditionSchema]),
    group_by: z.array(builderKeySchema).max(10),
    aggregates: z.array(moduleSourceQueryAggregateSchema).max(20),
    sort: z.array(moduleSourceQuerySortSchema).min(1).max(20),
    page_size: z.number().int().min(1).max(200),
    relationship_hops: z.number().int().min(0).max(2),
  })
  .strict();

// ---------------------------------------------------------------------------
// Module body and document.
// ---------------------------------------------------------------------------

const moduleSourceBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    dependencies: z.array(
      z
        .object({
          dependency_key: builderKeySchema,
          module: namespacedKeySchema,
          version: versionRequirementSchema,
        })
        .strict(),
    ).max(100),
    record_types: z.array(moduleSourceRecordTypeSchema).min(1).max(100),
    permissions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          label: labelSchema,
          description: z.string().min(1).max(1_000),
          record_type: builderKeySchema.optional(),
          action_kind: z.enum([
            "create",
            "read",
            "update",
            "delete",
            "restore",
            "export",
            "share",
            "manage",
            "named",
          ]),
          named_action: builderKeySchema.optional(),
          administrative: z.boolean(),
          record_scope: moduleSourcePermissionRecordScopeSchema.optional(),
          field_policy: sourcePermissionFieldPolicySchema.optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.field_policy !== undefined && value.record_type === undefined)
            context.addIssue({
              code: "custom",
              path: ["field_policy"],
              message: "Only record permissions may declare a field policy",
            });
        }),
    ).max(100),
    actions: z.array(moduleSourceActionSchema).max(100),
    events: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          record_type: builderKeySchema,
          carries: z.array(builderKeySchema).max(500),
          personal_or_sensitive_values_allowed: z.literal(false),
        })
        .strict(),
    ).max(100),
    rules: z.array(sourceRuleGraphSchema).max(100),
    extension_points: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          record_type: builderKeySchema,
          accepts: z.array(z.enum(["field", "action", "choice_option", "link_target"])).min(1),
        })
        .strict(),
    ).max(100),
    sharing_conditions: z.array(moduleSourceSharingConditionSchema).max(100),
    queries: z.array(moduleSourceQuerySchema).max(100).default([]),
  })
  .strict();

const moduleSourceDocumentBaseSchema = z
  .object({
    ...authoredSourceBase,
    kind: z.literal("module"),
    source_contract_version: z.literal(moduleSourceContractVersion),
    body: moduleSourceBodySchema,
  })
  .strict();

export const moduleSourceDocumentSchema = z.preprocess(
  inspectSourceBounds,
  moduleSourceDocumentBaseSchema,
);

export type ModuleSourceField = z.infer<typeof moduleSourceFieldSchema>;
export type ModuleSourceActionInput = z.infer<typeof moduleSourceActionInputSchema>;
export type ModuleSourceAction = z.infer<typeof moduleSourceActionSchema>;
export type ModuleSourceRecordType = z.infer<typeof moduleSourceRecordTypeSchema>;
export type ModuleSourceSharingCondition = z.infer<typeof moduleSourceSharingConditionSchema>;
export type ModuleSourceQuerySort = z.infer<typeof moduleSourceQuerySortSchema>;
export type ModuleSourceQueryAggregate = z.infer<typeof moduleSourceQueryAggregateSchema>;
export type ModuleSourceQuery = z.infer<typeof moduleSourceQuerySchema>;
export type ModuleSourceBody = z.infer<typeof moduleSourceBodySchema>;
export type ModuleSourceDocument = z.infer<typeof moduleSourceDocumentSchema>;
