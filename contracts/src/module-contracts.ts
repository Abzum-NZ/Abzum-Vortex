import { z } from "zod";
import { jsonValueSchema, labelSchema } from "./common";
import { personalDataClassSchema, publicDisplaySchema, searchPrioritySchema } from "./catalogues";
import {
  actionIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  eventIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  platformIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  ruleIdSchema,
  storageContractIdSchema,
  workflowIdSchema,
} from "./identifiers";
import {
  moduleDefinitionEnvelopeSchema,
  publishedDefinitionReferenceSchema,
  publishedModuleReferenceSchema,
  recordTypeReferenceSchema,
  requireResolvedRecordTypeReferences,
  versionRequirementSchema,
} from "./definitions";
import type { ResolveRecordTypeReferences } from "./definitions";
import { permissionDeclarationSchema } from "./permissions";

const finiteNumberSchema = z.number().finite();
const optionSchema = z.object({ value: builderKeySchema, label: labelSchema }).strict();
const parentDeleteSchema = z.enum(["refuse", "empty_optional", "soft_delete_dependent"]);
const emptySettingsSchema = z.object({}).strict();

const textSettingsSchema = z
  .object({ maxLength: z.number().int().min(1).max(100_000), format: builderKeySchema.optional() })
  .strict();
const longTextSettingsSchema = z
  .object({ maxLength: z.number().int().min(1).max(1_000_000) })
  .strict();
const formattedTextSettingsSchema = z
  .object({
    allowedBlocks: z.array(z.enum(["paragraph", "heading", "list", "link", "attachment"])).min(1),
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
const decimalSettingsSchema = z
  .object({
    digitsBeforeDecimal: z.number().int().min(1).max(30),
    decimalPlaces: z.number().int().min(0).max(12),
    minimum: finiteNumberSchema.optional(),
    maximum: finiteNumberSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minimum === undefined || value.maximum === undefined || value.maximum >= value.minimum,
    { path: ["maximum"], message: "Maximum cannot be below minimum" },
  );
const moneySettingsSchema = z
  .object({
    currencyMode: z.enum(["fixed", "organization_default"]),
    currency: z.string().length(3).optional(),
    minimum: finiteNumberSchema.optional(),
    maximum: finiteNumberSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.currencyMode === "fixed") !== (value.currency !== undefined))
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Fixed money requires exactly one currency",
      });
    if (value.minimum !== undefined && value.maximum !== undefined && value.maximum < value.minimum)
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
const severalChoicesSettingsSchema = z
  .object({
    options: z.array(optionSchema).min(1).max(200),
    maximumSelections: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const referenceNumberSettingsSchema = z
  .object({
    digits: z.number().int().min(1).max(20),
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    startingNumber: z.number().int().positive().optional(),
  })
  .strict();
const phoneSettingsSchema = z.object({ defaultCountry: z.string().length(2).optional() }).strict();
const webAddressSettingsSchema = z
  .object({ allowedSchemes: z.array(z.literal("https")).min(1).optional() })
  .strict();
const tableColumnSchema = z
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
  .strict();
const tableSettingsSchema = z
  .object({
    columns: z.array(tableColumnSchema).min(1).max(40),
    minimumRows: z.number().int().min(0),
    maximumRows: z.number().int().min(1).max(1_000),
  })
  .strict()
  .refine((value) => value.maximumRows >= value.minimumRows, {
    path: ["maximumRows"],
    message: "Maximum rows cannot be below minimum rows",
  });
const linkSettingsSchema = z
  .object({
    target: recordTypeReferenceSchema,
    reverseKey: builderKeySchema,
    onParentDelete: parentDeleteSchema,
  })
  .strict();
const multiLinkSettingsSchema = z
  .object({
    targets: z.array(recordTypeReferenceSchema).min(1).max(20),
    onParentDelete: parentDeleteSchema,
  })
  .strict();
const personLinkSettingsSchema = z
  .object({
    audience: z.enum(["organization_accounts", "application_accounts"]),
    applicationRootIdRequired: z.boolean(),
    onPersonDeactivation: z.enum(["retain_reference", "empty_optional", "refuse_deactivation"]),
  })
  .strict();
const calculationNumberOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("literal"), value: finiteNumberSchema }).strict(),
]);
const calculationDateOffsetSchema = z
  .object({
    kind: z.literal("date_offset"),
    dateFieldId: fieldIdSchema,
    amount: calculationNumberOperandSchema,
    unit: z.enum(["days", "weeks", "months", "years"]),
  })
  .strict();
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
      operation: z.enum(["add", "subtract", "multiply", "divide"]),
      operands: z.array(calculationNumberOperandSchema).min(2).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("subtract_percentage"),
      amountFieldId: fieldIdSchema,
      percentageFieldId: fieldIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("condition"),
      condition: z.lazy(() => conditionNodeSchema),
    })
    .strict(),
  calculationDateOffsetSchema,
]);
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
    expression: calculationExpressionSchema,
    dependencyFieldIds: z.array(fieldIdSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.expression.kind === "join_text" && value.resultType === "text") ||
      (value.expression.kind === "condition" && value.resultType === "yes_no") ||
      (value.expression.kind === "date_offset" &&
        (value.resultType === "date" || value.resultType === "date_time")) ||
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
const totalSettingsSchema = z
  .object({
    relationshipId: containedComponentIdSchema,
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    fieldId: fieldIdSchema.optional(),
    filter: z.lazy(() => conditionNodeSchema).optional(),
    currency: z.string().length(3).optional(),
  })
  .strict();
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
  default: jsonValueSchema.optional(),
  unique: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  searchPriority: searchPrioritySchema.optional(),
  personalData: personalDataClassSchema,
  publicDisplay: publicDisplaySchema,
};

const field = <K extends string, S extends z.ZodType>(type: K, settings: S) =>
  z.object({ ...fieldBase, type: z.literal(type), settings }).strict();
export const fieldDefinitionSchema = z
  .discriminatedUnion("type", [
    field("text", textSettingsSchema),
    field("long_text", longTextSettingsSchema),
    field("formatted_text", formattedTextSettingsSchema),
    field("whole_number", wholeNumberSettingsSchema),
    field("decimal_number", decimalSettingsSchema),
    field("money", moneySettingsSchema),
    field("yes_no", emptySettingsSchema),
    field("date", dateSettingsSchema),
    field("date_time", dateTimeSettingsSchema),
    field("choice", choiceSettingsSchema),
    field("several_choices", severalChoicesSettingsSchema),
    field("reference_number", referenceNumberSettingsSchema),
    field("email_address", emptySettingsSchema),
    field("phone_number", phoneSettingsSchema),
    field("web_address", webAddressSettingsSchema),
    field("table", tableSettingsSchema),
    field("link", linkSettingsSchema),
    field("link_to_one_of_several", multiLinkSettingsSchema),
    field("link_to_person", personLinkSettingsSchema),
    field("calculation", calculationSettingsSchema),
    field("total", totalSettingsSchema),
    field("attachment", attachmentSettingsSchema),
  ])
  .superRefine((value, context) => {
    if (value.default === undefined) return;
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", path: ["default"], message });
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
          invalid("Default must be one published choice");
        break;
      case "several_choices":
        if (
          !Array.isArray(value.default) ||
          !value.default.every(
            (item) =>
              typeof item === "string" &&
              value.settings.options.some((option) => option.value === item),
          )
        )
          invalid("Every default must be one published choice");
        break;
      case "table":
        if (
          !Array.isArray(value.default) ||
          value.default.length < value.settings.minimumRows ||
          value.default.length > value.settings.maximumRows ||
          !value.default.every(
            (row) => typeof row === "object" && row !== null && !Array.isArray(row),
          )
        )
          invalid("Default must be a table within the configured row limits");
        break;
      case "link":
      case "link_to_one_of_several":
      case "link_to_person":
        if (typeof value.default !== "string" || !platformIdSchema.safeParse(value.default).success)
          invalid("Default must be a platform-issued record or account identifier");
        break;
      case "reference_number":
      case "calculation":
      case "total":
      case "attachment":
        invalid("This field type does not accept a definition default");
        break;
    }
  });

export const moduleDependencySchema = z
  .object({
    dependencyKey: builderKeySchema,
    moduleRootId: moduleRootIdSchema,
    moduleKey: namespacedKeySchema,
    version: versionRequirementSchema,
  })
  .strict();

export const relationshipDefinitionSchema = z
  .object({
    relationshipId: containedComponentIdSchema,
    key: builderKeySchema,
    fromRecordTypeId: recordTypeIdSchema,
    fromFieldId: fieldIdSchema,
    toRecordType: recordTypeReferenceSchema,
    cardinality: z.enum(["one_to_one", "many_to_one", "many_to_many"]),
    onParentDelete: parentDeleteSchema,
  })
  .strict();

const conditionOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("value"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("parameter"), key: builderKeySchema }).strict(),
]);
const comparisonConditionSchema = z
  .object({
    kind: z.literal("comparison"),
    operator: z.enum([
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "in",
      "not_in",
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
      "is_empty",
      "is_not_empty",
    ]),
    left: conditionOperandSchema,
    right: conditionOperandSchema.optional(),
  })
  .strict();
export type ConditionNode =
  | z.infer<typeof comparisonConditionSchema>
  | { kind: "all" | "any"; conditions: ConditionNode[] }
  | { kind: "not"; condition: ConditionNode };
export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    comparisonConditionSchema,
    z
      .object({ kind: z.literal("all"), conditions: z.array(conditionNodeSchema).min(1).max(50) })
      .strict(),
    z
      .object({ kind: z.literal("any"), conditions: z.array(conditionNodeSchema).min(1).max(50) })
      .strict(),
    z.object({ kind: z.literal("not"), condition: conditionNodeSchema }).strict(),
  ]),
);

const actionValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("input"), inputKey: builderKeySchema }).strict(),
  z.object({ source: z.literal("subject_field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("subject_record") }).strict(),
  z.object({ source: z.literal("current_actor") }).strict(),
  z.object({ source: z.literal("current_time") }).strict(),
]);
const actionEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("set_field"), fieldId: fieldIdSchema, value: actionValueSchema })
    .strict(),
  z
    .object({
      kind: z.literal("create_record"),
      recordType: recordTypeReferenceSchema,
      values: z.record(fieldIdSchema, actionValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("copy_relationships"),
      relationshipIds: z.array(containedComponentIdSchema).min(1),
      targetInputKey: builderKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("soft_delete_subject") }).strict(),
  z.object({ kind: z.literal("announce_event"), eventKey: namespacedKeySchema }).strict(),
]);
const actionInputBase = {
  key: builderKeySchema,
  label: labelSchema,
  required: z.boolean(),
};
const textActionInputSchema = z
  .object({
    ...actionInputBase,
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
  .strict();
const formattedTextActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal("formatted_text"),
    validation: z
      .object({
        allowedBlocks: z
          .array(z.enum(["paragraph", "heading", "list", "link", "attachment"]))
          .min(1),
        maximumLength: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const numberActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal("number"),
    validation: z
      .object({ minimum: z.number().finite().optional(), maximum: z.number().finite().optional() })
      .strict()
      .optional(),
  })
  .strict();
const dateActionInputSchema = z
  .object({
    ...actionInputBase,
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
  .strict();
const dateTimeActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal("date_time"),
    validation: z
      .object({
        earliest: z.string().datetime({ offset: true }).optional(),
        latest: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const actionInputDefinitionSchema = z
  .discriminatedUnion("type", [
    textActionInputSchema,
    formattedTextActionInputSchema,
    numberActionInputSchema,
    z.object({ ...actionInputBase, type: z.literal("boolean") }).strict(),
    dateActionInputSchema,
    dateTimeActionInputSchema,
    z
      .object({
        ...actionInputBase,
        type: z.literal("record_reference"),
        recordTypes: z.array(recordTypeReferenceSchema).min(1).max(20),
      })
      .strict(),
    z
      .object({
        ...actionInputBase,
        type: z.literal("organization_account_reference"),
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
export const actionDefinitionSchema = z
  .object({
    actionId: actionIdSchema,
    key: namespacedKeySchema,
    label: labelSchema,
    subjectRecordTypeId: recordTypeIdSchema,
    permissionKey: namespacedKeySchema,
    sharing: z.enum(["refused", "allowed"]),
    inputs: z.array(actionInputDefinitionSchema).max(50),
    precondition: conditionNodeSchema.optional(),
    effects: z.array(actionEffectSchema).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.inputs.map((input) => input.key)).size !== value.inputs.length)
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "Action input keys must be unique",
      });
  });

const ruleEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refuse"), reasonCode: builderKeySchema }).strict(),
  z
    .object({ kind: z.literal("set_value"), fieldId: fieldIdSchema, value: jsonValueSchema })
    .strict(),
  z.object({ kind: z.literal("require"), fieldId: fieldIdSchema }).strict(),
  z
    .object({
      kind: z.literal("show_or_hide"),
      componentId: containedComponentIdSchema,
      visibility: z.enum(["show", "hide"]),
    })
    .strict(),
  z.object({ kind: z.literal("warn"), messageKey: builderKeySchema }).strict(),
  z.object({ kind: z.literal("start_background_work"), workflowId: workflowIdSchema }).strict(),
]);
export const ruleDefinitionSchema = z
  .object({
    ruleId: ruleIdSchema,
    key: builderKeySchema,
    subjectRecordTypeId: recordTypeIdSchema,
    trigger: z.enum(["create", "change", "delete", "form_change", "action"]),
    condition: conditionNodeSchema,
    priority: z.number().int().min(0).max(10_000),
    effect: ruleEffectSchema,
  })
  .strict();

export const eventDefinitionSchema = z
  .object({
    eventId: eventIdSchema,
    key: namespacedKeySchema,
    recordTypeId: recordTypeIdSchema,
    carriedFieldIds: z.array(fieldIdSchema).max(30),
    personalOrSensitiveValuesAllowed: z.literal(false),
  })
  .strict();

export const recordTypeDefinitionSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    key: builderKeySchema,
    singularLabel: labelSchema,
    pluralLabel: labelSchema,
    titleFieldId: fieldIdSchema,
    storageContractId: storageContractIdSchema,
    storageScope: z.enum(["organization_shared", "application_contained"]),
    ownershipMode: z.enum(["none", "organization_account", "team", "inherited"]),
    ownershipRelationshipId: containedComponentIdSchema.optional(),
    fields: z.array(fieldDefinitionSchema).min(1).max(500),
    relationships: z.array(relationshipDefinitionSchema),
    standardActions: z
      .array(z.enum(["create", "read", "update", "soft_delete", "restore", "export"]))
      .min(1),
    customActionIds: z.array(actionIdSchema),
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

export const savedSharingConditionSchema = z
  .object({
    conditionId: containedComponentIdSchema,
    sourceRecordTypeId: recordTypeIdSchema,
    key: builderKeySchema,
    publishedRevision: revisionSchema,
    contractFingerprint: fingerprintSchema,
    parameters: z.array(
      z
        .object({
          key: builderKeySchema,
          type: z.enum(["text", "number", "boolean", "date", "date_time"]),
        })
        .strict(),
    ),
    condition: conditionNodeSchema,
    declaredFieldIds: z.array(fieldIdSchema),
    publicationTests: z
      .array(
        z
          .object({
            name: labelSchema,
            parameters: z.record(builderKeySchema, jsonValueSchema),
            fieldValues: z.record(fieldIdSchema, jsonValueSchema),
            expected: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const moduleContentSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    dependencies: z.array(moduleDependencySchema),
    recordTypes: z.array(recordTypeDefinitionSchema).min(1).max(100),
    permissions: z.array(permissionDeclarationSchema),
    actions: z.array(actionDefinitionSchema),
    events: z.array(eventDefinitionSchema),
    rules: z.array(ruleDefinitionSchema),
    sharingConditions: z.array(savedSharingConditionSchema),
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
  })
  .strict();

export const moduleDraftSchema = z
  .object({ envelope: moduleDefinitionEnvelopeSchema, content: moduleContentSchema })
  .strict();
export const publishedModuleDefinitionSchema = z
  .object({
    publication: publishedModuleReferenceSchema,
    content: moduleContentSchema,
    dependencyManifest: z.array(publishedDefinitionReferenceSchema),
    releaseNote: z.string().min(1).max(2_000),
  })
  .strict()
  .superRefine((value, context) =>
    requireResolvedRecordTypeReferences(value.content, context, ["content"]),
  )
  .transform(
    (
      value,
    ): Omit<typeof value, "content"> & {
      content: ResolveRecordTypeReferences<typeof value.content>;
    } =>
      value as unknown as Omit<typeof value, "content"> & {
        content: ResolveRecordTypeReferences<typeof value.content>;
      },
  );

export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
export type ModuleDependency = z.infer<typeof moduleDependencySchema>;
export type RelationshipDefinition = z.infer<typeof relationshipDefinitionSchema>;
export type Condition = z.infer<typeof conditionNodeSchema>;
export type RecordTypeDefinition = z.infer<typeof recordTypeDefinitionSchema>;
export type ModuleContent = z.infer<typeof moduleContentSchema>;
export type ModuleDraft = z.infer<typeof moduleDraftSchema>;
export type PublishedModuleDefinition = z.infer<typeof publishedModuleDefinitionSchema>;
export type ActionDefinition = z.infer<typeof actionDefinitionSchema>;
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export type EventDefinition = z.infer<typeof eventDefinitionSchema>;
export type SavedSharingCondition = z.infer<typeof savedSharingConditionSchema>;
