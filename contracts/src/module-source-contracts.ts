import { z } from "zod";
import { personalDataClassSchema, publicDisplaySchema, searchPrioritySchema } from "./catalogues";
import { builderKeySchema, namespacedKeySchema, platformIdSchema } from "./identifiers";
import { jsonValueSchema } from "./common";
import { versionRequirementSchema } from "./definitions";
import {
  authoredSourceBase,
  sourceActionEffectSchema,
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedRelationshipSchema,
  sourceQualifiedRecordTypeSchema,
} from "./definition-source-common";
import { moduleSourceRecordOwnershipModeV1Schema } from "./record-ownership-compatibility";

const sourceOptionSchema = z
  .object({ value: z.string().min(1).max(120), label: z.string().min(1).max(60) })
  .strict();
const sourceFieldBase = {
  id: sourceAliasSchema,
  key: builderKeySchema,
  label: z.string().min(1).max(60),
  help_text: z.string().max(200).optional(),
  required: z.boolean(),
  default: jsonValueSchema.optional(),
  unique: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  search_priority: searchPrioritySchema.optional(),
  personal_data: personalDataClassSchema,
  public_display: publicDisplaySchema,
};
const sourceField = <K extends string, S extends z.ZodType>(type: K, settings: S) =>
  z.object({ ...sourceFieldBase, type: z.literal(type), settings }).strict();
const numberRange = {
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
};
const empty = z.object({}).strict();
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
const sourceCalculationNumberOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("literal"), value: z.number().finite() }).strict(),
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
  z
    .object({
      operation: z.literal("condition"),
      condition: sourceConditionSchema,
    })
    .strict(),
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
const sourceFieldMembers = [
  sourceField(
    "text",
    z
      .object({
        max_length: z.number().int().min(1).max(100_000),
        format: builderKeySchema.optional(),
      })
      .strict(),
  ),
  sourceField(
    "long_text",
    z.object({ max_length: z.number().int().min(1).max(1_000_000) }).strict(),
  ),
  sourceField(
    "formatted_text",
    z
      .object({
        allowed_blocks: z
          .array(z.enum(["paragraph", "heading", "list", "table", "link", "attachment"]))
          .min(1),
        max_length: z.number().int().positive().optional(),
      })
      .strict(),
  ),
  sourceField(
    "whole_number",
    z
      .object({
        minimum: z.number().int().optional(),
        maximum: z.number().int().optional(),
        step: z.number().int().positive().optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.minimum === undefined ||
          value.maximum === undefined ||
          value.maximum >= value.minimum,
        { path: ["maximum"], message: "Maximum cannot be below minimum" },
      ),
  ),
  sourceField(
    "decimal_number",
    z
      .object({
        ...numberRange,
        digits_before_decimal: z.number().int().min(1).max(30),
        decimal_places: z.number().int().min(0).max(12),
      })
      .strict()
      .refine(
        (value) =>
          value.minimum === undefined ||
          value.maximum === undefined ||
          value.maximum >= value.minimum,
        { path: ["maximum"], message: "Maximum cannot be below minimum" },
      ),
  ),
  sourceField(
    "money",
    z
      .object({
        currency_mode: z.enum(["fixed", "organisation_default"]),
        currency: z.string().length(3).optional(),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
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
          value.maximum < value.minimum
        )
          context.addIssue({
            code: "custom",
            path: ["maximum"],
            message: "Maximum cannot be below minimum",
          });
      }),
  ),
  sourceField("yes_no", empty),
  sourceField(
    "date",
    z.object({ earliest: z.iso.date().optional(), latest: z.iso.date().optional() }).strict(),
  ),
  sourceField(
    "date_time",
    z
      .object({
        display_time_zone: z.enum(["person", "organisation", "utc"]).optional(),
      })
      .strict(),
  ),
  sourceField(
    "choice",
    z.object({ options: z.array(sourceOptionSchema).min(1).max(200) }).strict(),
  ),
  sourceField(
    "several_choices",
    z
      .object({
        options: z.array(sourceOptionSchema).min(1).max(200),
        maximum_selections: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
  ),
  sourceField(
    "reference_number",
    z
      .object({
        prefix: z.string().max(20).optional(),
        suffix: z.string().max(20).optional(),
        digits: z.number().int().min(1).max(20),
        starting_number: z.number().int().positive().optional(),
      })
      .strict(),
  ),
  sourceField("email_address", empty),
  sourceField(
    "phone_number",
    z.object({ default_country: z.string().length(2).optional() }).strict(),
  ),
  sourceField(
    "web_address",
    z.object({ allowed_schemes: z.array(z.literal("https")).min(1).optional() }).strict(),
  ),
  sourceField(
    "table",
    z
      .object({
        minimum_rows: z.number().int().min(0),
        maximum_rows: z.number().int().min(1).max(1_000),
        columns: z
          .array(
            z
              .object({
                key: builderKeySchema,
                type: z.enum([
                  "text",
                  "whole_number",
                  "decimal_number",
                  "money",
                  "yes_no",
                  "date",
                  "date_time",
                  "choice",
                ]),
                required: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(40),
      })
      .strict()
      .refine((value) => value.maximum_rows >= value.minimum_rows, {
        path: ["maximum_rows"],
        message: "Maximum rows cannot be below minimum rows",
      }),
  ),
  sourceField(
    "link",
    z
      .object({
        target: sourceQualifiedRecordTypeSchema,
        reverse_key: builderKeySchema,
        on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
      })
      .strict(),
  ),
  sourceField(
    "link_to_one_of_several",
    z
      .object({
        targets: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20),
        on_parent_delete: z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
      })
      .strict(),
  ),
  sourceField(
    "link_to_person",
    z
      .object({
        audience: z.enum([
          "organisation_accounts",
          "application_accounts",
          "organisation_identities_and_external_requesters",
        ]),
        application_root_required: z.boolean(),
        on_person_deactivation: z.enum([
          "retain_reference",
          "empty_optional",
          "refuse_deactivation",
        ]),
      })
      .strict(),
  ),
  sourceField(
    "calculation",
    z
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
        expression: sourceCalculationExpressionSchema,
      })
      .strict(),
  ),
  sourceField(
    "total",
    z
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
        currency: z.string().length(3).optional(),
      })
      .strict(),
  ),
  sourceField("attachment", sourceAttachmentSettingsSchema),
] as const;
export const moduleSourceFieldSchema = z
  .discriminatedUnion("type", sourceFieldMembers)
  .superRefine((value, context) => {
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", path: ["default"], message });
    if (value.default !== undefined) {
      switch (value.type) {
        case "text":
        case "long_text":
        case "formatted_text":
        case "email_address":
        case "phone_number":
        case "web_address":
          if (typeof value.default !== "string") invalid("Default must be text");
          break;
        case "whole_number":
          if (!Number.isInteger(value.default)) invalid("Default must be a whole number");
          break;
        case "decimal_number":
        case "money":
          if (typeof value.default !== "number" || !Number.isFinite(value.default))
            invalid("Default must be a number");
          break;
        case "yes_no":
          if (typeof value.default !== "boolean") invalid("Default must be yes or no");
          break;
        case "date":
          if (typeof value.default !== "string" || !z.iso.date().safeParse(value.default).success)
            invalid("Default must be an ISO date");
          break;
        case "date_time":
          if (
            typeof value.default !== "string" ||
            !z.iso.datetime({ offset: true }).safeParse(value.default).success
          )
            invalid("Default must be an ISO date and time with an offset");
          break;
        case "choice":
          if (
            typeof value.default !== "string" ||
            !value.settings.options.some((option) => option.value === value.default)
          )
            invalid("Default must be one declared choice");
          break;
        case "several_choices":
          if (
            !Array.isArray(value.default) ||
            !value.default.every(
              (item) =>
                typeof item === "string" &&
                value.settings.options.some((option) => option.value === item),
            ) ||
            (value.settings.maximum_selections !== undefined &&
              value.default.length > value.settings.maximum_selections)
          )
            invalid("Every default must be a declared choice within the selection limit");
          break;
        case "table":
          if (
            !Array.isArray(value.default) ||
            value.default.length < value.settings.minimum_rows ||
            value.default.length > value.settings.maximum_rows ||
            !value.default.every(
              (row) => typeof row === "object" && row !== null && !Array.isArray(row),
            )
          )
            invalid("Default must be a table within the configured row limits");
          break;
        case "link":
        case "link_to_one_of_several":
        case "link_to_person":
          if (
            typeof value.default !== "string" ||
            !platformIdSchema.safeParse(value.default).success
          )
            invalid("Default must be a platform-issued record or account identifier");
          break;
        case "reference_number":
        case "calculation":
        case "total":
        case "attachment":
          invalid("This field type does not accept a definition default");
          break;
      }
    }
    if (value.type === "calculation") {
      const operation = value.settings.expression.operation;
      const validResultTypes: Readonly<Record<typeof operation, readonly string[]>> = {
        join_text: ["text"],
        numeric: ["whole_number", "decimal_number", "money"],
        subtract_percentage: ["decimal_number", "money"],
        condition: ["yes_no"],
        date_offset: ["date", "date_time"],
        deadline_passed: ["yes_no"],
      };
      if (!validResultTypes[operation].includes(value.settings.result_type))
        context.addIssue({
          code: "custom",
          path: ["settings", "result_type"],
          message: "Calculation result type must match its operation",
        });
    }
    if (value.type === "total") {
      const needsField = value.settings.operation !== "count";
      if (needsField !== (value.settings.field !== undefined))
        context.addIssue({
          code: "custom",
          path: ["settings", "field"],
          message: "Only non-count totals require a field",
        });
      if (value.settings.currency !== undefined && value.settings.operation !== "sum")
        context.addIssue({
          code: "custom",
          path: ["settings", "currency"],
          message: "Currency is supported only for sum totals",
        });
      if (value.settings.operation === "count" && value.settings.result_type !== "whole_number")
        context.addIssue({
          code: "custom",
          path: ["settings", "result_type"],
          message: "Count totals produce a whole number",
        });
      if (
        ["sum", "average"].includes(value.settings.operation) &&
        !["whole_number", "decimal_number", "money"].includes(value.settings.result_type)
      )
        context.addIssue({
          code: "custom",
          path: ["settings", "result_type"],
          message: "Sum and average totals require a numeric result type",
        });
    }
  });
const moduleFixtureFieldSchema = moduleSourceFieldSchema;

// Modules do not own application components or workflows. Those two rule effects
// are therefore deliberately available only from the application source contract.
const moduleSourceRuleEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refuse"), reason_code: builderKeySchema }).strict(),
  z
    .object({ kind: z.literal("set_value"), field: builderKeySchema, value: jsonValueSchema })
    .strict(),
  z.object({ kind: z.literal("require"), field: builderKeySchema }).strict(),
  z.object({ kind: z.literal("warn"), message: builderKeySchema }).strict(),
]);

const moduleFixtureRecordTypeSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    name: z.string().min(1).max(60),
    plural_name: z.string().min(1).max(60),
    title_field: builderKeySchema,
    storage_contract_id: sourceAliasSchema,
    storage_scope: z.enum(["organisation_shared", "application_contained"]),
    ownership_mode: moduleSourceRecordOwnershipModeV1Schema,
    ownership_relationship: builderKeySchema.optional(),
    standard_actions: z
      .array(z.enum(["create", "read", "update", "soft_delete", "restore", "export"]))
      .min(1),
    custom_actions: z.array(sourceAliasSchema),
    fields: z.array(moduleFixtureFieldSchema).min(1),
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
    ),
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
const sourceActionInputBase = {
  key: builderKeySchema,
  label: z.string().min(1).max(60),
  required: z.boolean(),
};
export const actionInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...sourceActionInputBase,
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
        ...sourceActionInputBase,
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
        ...sourceActionInputBase,
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
    z.object({ ...sourceActionInputBase, type: z.literal("boolean") }).strict(),
    z
      .object({
        ...sourceActionInputBase,
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
        ...sourceActionInputBase,
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
        ...sourceActionInputBase,
        type: z.literal("record_reference"),
        record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20),
      })
      .strict(),
    z
      .object({
        ...sourceActionInputBase,
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
    ),
    record_types: z.array(moduleFixtureRecordTypeSchema).min(1),
    permissions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          label: z.string().min(1).max(120),
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
        })
        .strict(),
    ),
    actions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          label: z.string().min(1).max(120),
          record_type: builderKeySchema,
          permission: namespacedKeySchema,
          shareable: z.boolean(),
          inputs: z.array(actionInputSchema),
          precondition: sourceConditionSchema.optional(),
          effects: z.array(sourceActionEffectSchema).min(1).max(10),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: namespacedKeySchema,
          record_type: builderKeySchema,
          carries: z.array(builderKeySchema),
          personal_or_sensitive_values_allowed: z.literal(false),
        })
        .strict(),
    ),
    rules: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          record_type: builderKeySchema,
          trigger: z.enum(["create", "change", "delete", "form_change", "action"]),
          priority: z.number().int().min(0).max(10_000),
          condition: sourceConditionSchema,
          effect: moduleSourceRuleEffectSchema,
        })
        .strict(),
    ),
    extension_points: z.array(
      z
        .object({
          id: sourceAliasSchema,
          key: builderKeySchema,
          record_type: builderKeySchema,
          accepts: z.array(z.enum(["field", "action", "choice_option", "link_target"])).min(1),
        })
        .strict(),
    ),
    sharing_conditions: z.array(
      z
        .object({
          id: sourceAliasSchema,
          source_record_type: builderKeySchema,
          key: builderKeySchema,
          parameters: z.array(
            z
              .object({
                key: builderKeySchema,
                type: z.enum(["text", "number", "boolean", "date", "date_time"]),
              })
              .strict(),
          ),
          condition: sourceConditionSchema,
          declared_fields: z.array(builderKeySchema),
          publication_tests: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(60),
                  parameters: z.record(builderKeySchema, jsonValueSchema),
                  field_values: z.record(builderKeySchema, jsonValueSchema),
                  expected: z.boolean(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const moduleSourceDocumentSchema = z
  .object({ ...authoredSourceBase, kind: z.literal("module"), body: moduleSourceBodySchema })
  .strict();
