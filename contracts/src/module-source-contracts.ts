import { z } from "zod";
import { personalDataClassSchema, publicDisplaySchema, searchPrioritySchema } from "./catalogues";
import { builderKeySchema, namespacedKeySchema, organizationAccountIdSchema } from "./identifiers";
import {
  calculationMaximumNestingDepth,
  calculationMaximumOperandCount,
  jsonValueSchema,
  labelSchema,
  safeHttpsUrlSchema,
} from "./common";
import { versionRequirementSchema } from "./definitions";
import {
  authoredSourceBase,
  refineActionTaskIds,
  sourceActionTaskSchema,
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedRecordTypeSchema,
  sourceQualifiedRelationshipSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "./definition-source-common";
import { parseExactDecimal } from "./exact-decimal";
import { compileTextInputPattern } from "./text-input-pattern";
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
import { sourceFlowCollectionSchema } from "./flow-source-contracts";
import { protectedReadModelKeySchema } from "./application-composition-v2";
import { PLATFORM_SERVICE_OPERATIONS } from "./platform-service-operation-catalogue";

/** The one current Module source/validation contract pair. */
export const moduleSourceContractVersion = "3.0.0" as const;

/** The closed set of protected projections that may declare the standard update action. */
export const writableSystemProjectionRegistrations = Object.freeze({
  organization_settings: Object.freeze({
    moduleKey: "vortex.organisation_administration",
    protectedView: "organization_runtime_settings",
    writer: "save_organization_settings_record",
  }),
} as const);

export const isRegisteredWritableSystemProjection = (
  recordTypeKey: string,
  protectedView: string,
  moduleKey?: string,
): boolean =>
  Object.entries(writableSystemProjectionRegistrations).some(
    ([key, registration]) =>
      key === recordTypeKey &&
      registration.protectedView === protectedView &&
      (moduleKey === undefined || registration.moduleKey === moduleKey),
  );

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
    if (Array.isArray(entry.value) && entry.value.length > maximumSourceContainerItems) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source container has too many items",
      });
      return z.NEVER;
    }
    const keys: string[] | undefined = Array.isArray(entry.value) ? undefined : [];
    if (keys !== undefined) {
      for (const key in entry.value) {
        if (!Object.prototype.hasOwnProperty.call(entry.value, key)) continue;
        keys.push(key);
        if (keys.length > maximumSourceContainerItems) break;
      }
    }
    if (keys !== undefined && keys.length > maximumSourceContainerItems) {
      context.addIssue({
        code: "custom",
        path: entry.path,
        message: "Source container has too many items",
      });
      return z.NEVER;
    }
    ancestors.add(entry.value);
    pending.push({ value: undefined, path: [], depth: 0, exit: entry.value });
    const count = keys?.length ?? (entry.value as unknown[]).length;
    for (let index = count - 1; index >= 0; index -= 1) {
      const key = keys?.[index] ?? index;
      const child = (entry.value as Record<string | number, unknown>)[key];
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
  z.object({ kind: sourceProvenanceUnchanged(z.literal("all_records")) }).strict(),
  z.object({ kind: sourceProvenanceUnchanged(z.literal("ownership")) }).strict(),
  z.object({ kind: sourceProvenanceUnchanged(z.literal("direct_share")) }).strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("relationship")),
      relationship: sourceProvenanceTarget(sourceQualifiedRelationshipSchema, ["relationshipId"]),
      source_permission: sourceProvenanceTarget(namespacedKeySchema, ["sourcePermissionId"]),
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
  .object({
    routes: sourceProvenanceUnchanged(
      z.array(sourcePermissionRecordScopeRouteSchema).min(1).max(100),
    ),
  })
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
      key: sourceProvenanceUnchanged(builderKeySchema),
      source: sourceProvenanceUnchanged(z.literal("current_organization_account_id")),
    })
    .strict(),
  z
    .object({
      key: sourceProvenanceUnchanged(builderKeySchema),
      source: sourceProvenanceUnchanged(z.literal("literal")),
      value: sourceProvenanceUnchanged(jsonValueSchema),
    })
    .strict(),
]);

export const moduleSourcePermissionRecordScopeSchema =
  sourcePermissionRecordScopeBaseSchema.safeExtend({
    saved_condition: sourceProvenanceUnchanged(
      z
        .object({
          condition: sourceProvenanceTarget(builderKeySchema, [
            "conditionId",
            "publishedRevision",
            "contractFingerprint",
          ]),
          parameter_bindings: sourceProvenanceUnchanged(
            z.array(sourceSavedConditionParameterBindingSchema),
          ),
        })
        .strict()
        .optional(),
    ),
  });

export const sourcePermissionFieldPolicySchema = z
  .object({
    readable_fields: sourceProvenanceUnchanged(
      z.array(sourceProvenanceTarget(builderKeySchema, ["readableFieldIds/#"])).max(500),
    ),
    changeable_fields: sourceProvenanceUnchanged(
      z.array(sourceProvenanceTarget(builderKeySchema, ["changeableFieldIds/#"])).max(500),
    ),
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

// A text pattern must compile under the shared bounded contract and always
// travels with a maximum length, so runtime matching stays bounded. Module and
// application action and query inputs share this rule.
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
      message: "Pattern is invalid or uses an unsupported unsafe construct",
    });
};

const sourceSharedActionInputBase = {
  key: sourceProvenanceUnchanged(builderKeySchema),
  label: sourceProvenanceUnchanged(labelSchema),
  required: sourceProvenanceUnchanged(z.boolean()),
};

export const actionInputSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...sourceSharedActionInputBase,
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
        ...sourceSharedActionInputBase,
        type: sourceProvenanceTarget(z.literal("formatted_text"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              allowed_blocks: sourceProvenanceUnchanged(
                z.array(z.enum(["paragraph", "heading", "list", "link", "attachment"])).min(1),
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
        ...sourceSharedActionInputBase,
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
        ...sourceSharedActionInputBase,
        type: sourceProvenanceTarget(z.literal("boolean"), ["type"]),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: sourceProvenanceTarget(z.literal("date"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              earliest: sourceProvenanceUnchanged(
                z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/)
                  .optional(),
              ),
              latest: sourceProvenanceUnchanged(
                z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/)
                  .optional(),
              ),
            })
            .strict()
            .optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: sourceProvenanceTarget(z.literal("date_time"), ["type"]),
        validation: sourceProvenanceUnchanged(
          z
            .object({
              earliest: sourceProvenanceUnchanged(z.string().datetime({ offset: true }).optional()),
              latest: sourceProvenanceUnchanged(z.string().datetime({ offset: true }).optional()),
            })
            .strict()
            .optional(),
        ),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: sourceProvenanceTarget(z.literal("record_reference"), ["type"]),
        record_types: sourceProvenanceUnchanged(
          z
            .array(sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordTypes/#/**"]))
            .min(1)
            .max(20),
        ),
      })
      .strict(),
    z
      .object({
        ...sourceSharedActionInputBase,
        type: sourceProvenanceTarget(z.literal("organisation_account_reference"), ["type"]),
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
const sourceTextFormatSchema = z.enum(["email_address", "web_address", "uuid"]);
const sourceTextSettingsSchema = z
  .object({
    max_length: sourceProvenanceUnchanged(z.number().int().min(1).max(100_000)),
    format: sourceProvenanceUnchanged(sourceTextFormatSchema.optional()),
  })
  .strict();
const sourceLongTextSettingsSchema = z
  .object({ max_length: sourceProvenanceUnchanged(z.number().int().min(1).max(1_000_000)) })
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
    digits_before_decimal: sourceProvenanceUnchanged(z.number().int().min(1).max(30)),
    decimal_places: sourceProvenanceTarget(z.number().int().min(0).max(12), ["decimalPlaces"]),
    minimum: sourceProvenanceTarget(sourceExactDecimalTextV2Schema.optional(), ["minimum"]),
    maximum: sourceProvenanceTarget(sourceExactDecimalTextV2Schema.optional(), ["maximum"]),
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
    currency_mode: sourceProvenanceTarget(z.enum(["fixed", "organisation_default"]), [
      "currencyMode",
    ]),
    currency: sourceProvenanceUnchanged(currencyCodeV2Schema.optional()),
    minimum: sourceProvenanceTarget(sourceExactDecimalTextV2Schema.optional(), ["minimum"]),
    maximum: sourceProvenanceTarget(sourceExactDecimalTextV2Schema.optional(), ["maximum"]),
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
      z.enum(["person", "organisation", "utc"]).optional(),
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
        "organisation_accounts",
        "application_accounts",
        "organisation_identities_and_external_requesters",
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
      value: sourceProvenanceTarget(sourceExactDecimalTextV2Schema, ["value"]),
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
): { depth: number; values: number } => {
  if (value.source !== "numeric") return { depth, values: 1 };
  const inspected = value.operands.map((operand) =>
    inspectSourceCalculationNumberValue(operand, depth + 1),
  );
  return {
    depth: Math.max(depth, ...inspected.map((operand) => operand.depth)),
    values: 1 + inspected.reduce((total, operand) => total + operand.values, 0),
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
    const validResultTypes: Readonly<Record<typeof operation, readonly string[]>> = {
      join_text: ["text"],
      numeric: ["whole_number", "decimal_number", "money"],
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
    currency: sourceProvenanceUnchanged(currencyCodeV2Schema.optional()),
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
  key: sourceProvenanceUnchanged(builderKeySchema),
  label: sourceProvenanceUnchanged(labelSchema),
  required: sourceProvenanceUnchanged(z.boolean()),
};
const moduleSourceExactActionInputValidationSchema = z
  .object({
    minimum: sourceProvenanceTarget(sourceExactDecimalTextV2Schema.optional(), ["minimum"]),
    maximum: sourceProvenanceTarget(sourceExactDecimalTextV2Schema.optional(), ["maximum"]),
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
    z
      .object({
        ...moduleSourceActionInputBase,
        type: sourceProvenanceTarget(z.literal("organisation_account_reference"), ["type"]),
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

// ---------------------------------------------------------------------------
// Record types, actions and sharing conditions.
// ---------------------------------------------------------------------------

const systemRecordProtectedOperationKeys = Object.entries(PLATFORM_SERVICE_OPERATIONS)
  .filter(([, operation]) => operation.descriptor.expectedRevision === "required")
  .map(([key]) => key) as [string, ...string[]];

/**
 * A registered protected operation a system projection record type action may target: exactly the
 * platform-service catalogue operations that change one existing row at an expected revision, so
 * the subject row's identity and revision always have somewhere to go. The operation stays the only
 * write path over its protected fact, so an action names it by its registered key and never by an
 * identity. The operation requires its own registered permission and re-checks the actor's current
 * authority when it runs, in addition to the action's own permission.
 */
export const moduleSourceProtectedOperationKeySchema = z.enum(systemRecordProtectedOperationKeys);

/**
 * The system projection storage kind: the record type's typed fields project one registered
 * protected view (or the function behind it) rather than generated record storage. The projection
 * includes the organisation, so the declaration names the field that holds it; filterable and
 * sortable fields are the closed subset the query engine may use; and the revision field is the
 * concurrency number every protected operation re-checks.
 */
export const moduleSourceSystemProjectionSchema = z
  .object({
    protected_view: sourceProvenanceUnchanged(protectedReadModelKeySchema),
    organization_field: sourceProvenanceTarget(builderKeySchema, ["organizationFieldId"]),
    revision_field: sourceProvenanceTarget(builderKeySchema, ["revisionFieldId"]),
    filterable_fields: sourceProvenanceUnchanged(
      z.array(sourceProvenanceTarget(builderKeySchema, ["filterableFieldIds/#"])).max(500),
    ),
    sortable_fields: sourceProvenanceUnchanged(
      z.array(sourceProvenanceTarget(builderKeySchema, ["sortableFieldIds/#"])).max(500),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.filterable_fields).size !== value.filterable_fields.length)
      context.addIssue({
        code: "custom",
        path: ["filterable_fields"],
        message: "Filterable fields must be unique",
      });
    if (new Set(value.sortable_fields).size !== value.sortable_fields.length)
      context.addIssue({
        code: "custom",
        path: ["sortable_fields"],
        message: "Sortable fields must be unique",
      });
  });

/**
 * Field types whose values come from generated record storage (counters, relationship edges,
 * relationship totals, stored files or child rows) rather than a column of a protected view, so a
 * system projection record type cannot declare them.
 */
const systemProjectionRefusedFieldTypes: ReadonlySet<string> = new Set([
  "reference_number",
  "table",
  "link",
  "link_to_one_of_several",
  "total",
  "attachment",
]);

export const moduleSourceRecordTypeSchema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["recordTypeId", "fromRecordTypeId"]),
    key: sourceProvenanceUnchanged(builderKeySchema),
    name: sourceProvenanceTarget(labelSchema, ["singularLabel"]),
    plural_name: sourceProvenanceTarget(labelSchema, ["pluralLabel"]),
    title_field: sourceProvenanceTarget(builderKeySchema, ["titleFieldId"]),
    storage_contract_id: sourceProvenanceTarget(sourceAliasSchema, ["storageContractId"]),
    storage_scope: sourceProvenanceTarget(
      z.enum(["organisation_shared", "application_contained"]),
      ["storageScope"],
    ),
    system_projection: sourceProvenanceUnchanged(moduleSourceSystemProjectionSchema.optional()),
    ownership_mode: sourceProvenanceTarget(moduleSourceRecordOwnershipModeSchema, [
      "ownershipMode",
    ]),
    ownership_relationship: sourceProvenanceTarget(builderKeySchema.optional(), [
      "ownershipRelationshipId",
    ]),
    standard_actions: sourceProvenanceUnchanged(
      z
        .array(z.enum(["create", "read", "update", "soft_delete", "restore", "export"]))
        .min(1)
        .max(6),
    ),
    custom_actions: sourceProvenanceUnchanged(
      z.array(sourceProvenanceTarget(sourceAliasSchema, ["customActionIds/#"])).max(100),
    ),
    fields: sourceProvenanceUnchanged(z.array(moduleSourceFieldSchema).min(1).max(500)),
    relationships: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["relationshipId"]),
              key: sourceProvenanceUnchanged(builderKeySchema),
              from_field: sourceProvenanceTarget(builderKeySchema, ["fromFieldId"]),
              to_record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema.optional(), [
                "toRecordType/**",
              ]),
              to_record_types: sourceProvenanceTarget(
                z.array(sourceQualifiedRecordTypeSchema).min(2).max(20).optional(),
                ["toRecordTypes/#/**"],
                true,
              ),
              cardinality: sourceProvenanceUnchanged(
                z.enum(["one_to_one", "many_to_one", "many_to_many"]),
              ),
              on_parent_delete: sourceProvenanceUnchanged(
                z.enum(["refuse", "empty_optional", "soft_delete_dependent"]),
              ),
            })
            .strict()
            .refine(
              (value) =>
                (value.to_record_type !== undefined) !== (value.to_record_types !== undefined),
              { message: "Declare one target or a polymorphic target list" },
            ),
        )
        .max(500),
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
    const projection = value.system_projection;
    if (projection === undefined) return;
    // A system projection is read-only by default. Only a projection in the closed writable
    // registration may declare standard update; create, delete and restore always remain refused.
    if (value.storage_scope !== "organisation_shared")
      context.addIssue({
        code: "custom",
        path: ["storage_scope"],
        message: "A system projection record type is scoped to exactly one organisation",
      });
    const mayUpdate = isRegisteredWritableSystemProjection(value.key, projection.protected_view);
    if (
      value.standard_actions.some((action) =>
        action === "create" ||
        action === "soft_delete" ||
        action === "restore" ||
        (action === "update" && !mayUpdate),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["standard_actions"],
        message: "A system projection standard write action must be in the closed writable registration",
      });
    const fields = new Map(value.fields.map((field) => [field.key, field]));
    const organization = fields.get(projection.organization_field);
    if (organization === undefined || organization.type !== "text" || !organization.required)
      context.addIssue({
        code: "custom",
        path: ["system_projection", "organization_field"],
        message: "The organisation field must be a required text field of the record type",
      });
    const revision = fields.get(projection.revision_field);
    if (revision === undefined || revision.type !== "whole_number" || !revision.required)
      context.addIssue({
        code: "custom",
        path: ["system_projection", "revision_field"],
        message: "The revision field must be a required whole-number field of the record type",
      });
    for (const [index, field] of value.fields.entries())
      if (systemProjectionRefusedFieldTypes.has(field.type))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "type"],
          message: "A system projection field is a read-only value of its protected view",
        });
    const filterable = new Set(projection.filterable_fields);
    const sortable = new Set(projection.sortable_fields);
    for (const [index, key] of projection.filterable_fields.entries())
      if (!fields.get(key)?.filterable)
        context.addIssue({
          code: "custom",
          path: ["system_projection", "filterable_fields", index],
          message: "A declared filterable field must be a filterable field of the record type",
        });
    for (const [index, key] of projection.sortable_fields.entries())
      if (!fields.get(key)?.sortable)
        context.addIssue({
          code: "custom",
          path: ["system_projection", "sortable_fields", index],
          message: "A declared sortable field must be a sortable field of the record type",
        });
    // The declared lists are the closed set the query engine may use, so a field flagged
    // filterable or sortable outside them would be an undeclared query capability.
    for (const [index, field] of value.fields.entries()) {
      if (field.filterable && !filterable.has(field.key))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "filterable"],
          message: "Every filterable system projection field must be declared filterable",
        });
      if (field.sortable && !sortable.has(field.key))
        context.addIssue({
          code: "custom",
          path: ["fields", index, "sortable"],
          message: "Every sortable system projection field must be declared sortable",
        });
    }
  });

export const moduleSourceActionSchema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["actionId"]),
    key: sourceProvenanceUnchanged(namespacedKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    record_type: sourceProvenanceTarget(builderKeySchema, ["subjectRecordTypeId"]),
    permission: sourceProvenanceTarget(namespacedKeySchema.optional(), ["permissionKey"]),
    permission_alternatives: sourceProvenanceUnchanged(
      z.array(namespacedKeySchema).min(2).optional(),
    ),
    shareable: sourceProvenanceTarget(z.boolean(), ["sharing"]),
    inputs: sourceProvenanceUnchanged(z.array(moduleSourceActionInputSchema).max(50)),
    precondition: sourceProvenanceUnchanged(sourceConditionSchema.optional()),
    tasks: sourceProvenanceUnchanged(
      z.array(sourceActionTaskSchema).max(10).superRefine(refineActionTaskIds),
    ),
    protected_operation: sourceProvenanceTarget(
      moduleSourceProtectedOperationKeySchema.optional(),
      [
        "protectedOperation/owner/kind",
        "protectedOperation/owner/serviceId",
        "protectedOperation/operationId",
      ],
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const hasTasks = value.tasks.length > 0;
    const hasOperation = value.protected_operation !== undefined;
    if (hasTasks === hasOperation)
      context.addIssue({
        code: "custom",
        path: ["protected_operation"],
        message: "An action targets either ordered tasks or one registered protected operation",
      });
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
    key: sourceProvenanceUnchanged(builderKeySchema),
    type: sourceProvenanceUnchanged(
      z.enum([
        "text",
        "number",
        "decimal_number",
        "money",
        "boolean",
        "date",
        "date_time",
        "organization_account_reference",
      ]),
    ),
  })
  .strict();
const moduleSourceSharingPublicationTestSchema = z
  .object({
    name: sourceProvenanceUnchanged(labelSchema),
    parameters: sourceProvenanceTarget(
      z.record(builderKeySchema, jsonValueSchema),
      ["parameters/**"],
      true,
    ),
    field_values: sourceProvenanceTarget(
      z.record(builderKeySchema, jsonValueSchema),
      ["fieldValues/**"],
      true,
    ),
    expected: sourceProvenanceUnchanged(z.boolean()),
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
    id: sourceProvenanceTarget(sourceAliasSchema, ["conditionId"]),
    source_record_type: sourceProvenanceTarget(builderKeySchema, ["sourceRecordTypeId"]),
    key: sourceProvenanceUnchanged(builderKeySchema),
    parameters: sourceProvenanceUnchanged(z.array(moduleSourceSharingParameterSchema).max(100)),
    condition: sourceProvenanceUnchanged(sourceConditionSchema),
    declared_fields: sourceProvenanceUnchanged(
      z.array(sourceProvenanceTarget(builderKeySchema, ["declaredFieldIds/#"])).max(500),
    ),
    publication_tests: sourceProvenanceUnchanged(
      z.array(moduleSourceSharingPublicationTestSchema).min(1).max(100),
    ),
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
    field: sourceProvenanceTarget(builderKeySchema, ["fieldId"]),
    direction: sourceProvenanceUnchanged(z.enum(["ascending", "descending"])),
  })
  .strict();

export const moduleSourceQueryAggregateSchema = z
  .object({
    operation: sourceProvenanceUnchanged(z.enum(["count", "sum", "minimum", "maximum", "average"])),
    field: sourceProvenanceTarget(builderKeySchema.optional(), ["fieldId"]),
    alias: sourceProvenanceUnchanged(builderKeySchema),
  })
  .strict();

/**
 * One authored Module-owned query. It names a local or dependency-qualified record type,
 * typed inputs, the fields it returns, a typed filter tree, grouping, totals, a stable sort,
 * a bounded page size and its declared relationship hops. It never carries a database target.
 */
export const moduleSourceQuerySchema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["queryId"]),
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema.optional()),
    description: sourceProvenanceUnchanged(z.string().min(1).max(1_000).optional()),
    record_type: sourceProvenanceTarget(
      z.union([builderKeySchema, sourceQualifiedRecordTypeSchema]),
      ["recordType/**"],
    ),
    inputs: sourceProvenanceUnchanged(z.array(moduleSourceActionInputSchema).max(50)),
    select: sourceProvenanceUnchanged(
      z
        .array(sourceProvenanceTarget(builderKeySchema, ["selectedFieldIds/#"]))
        .min(1)
        .max(200),
    ),
    filter: sourceProvenanceUnchanged(z.union([z.null(), sourceConditionSchema])),
    group_by: sourceProvenanceUnchanged(
      z.array(sourceProvenanceTarget(builderKeySchema, ["groupByFieldIds/#"])).max(10),
    ),
    aggregates: sourceProvenanceUnchanged(z.array(moduleSourceQueryAggregateSchema).max(20)),
    sort: sourceProvenanceUnchanged(z.array(moduleSourceQuerySortSchema).min(1).max(20)),
    page_size: sourceProvenanceUnchanged(z.number().int().min(1).max(200)),
    relationship_hops: sourceProvenanceUnchanged(z.number().int().min(0).max(2)),
  })
  .strict();

// ---------------------------------------------------------------------------
// Module contributions.
// ---------------------------------------------------------------------------

const moduleSourceContributionBase = {
  id: sourceProvenanceTarget(sourceAliasSchema, ["contributionId"]),
  dependency: sourceProvenanceTarget(builderKeySchema, ["targetModule/**"]),
  extension_point: sourceProvenanceTarget(builderKeySchema, ["targetExtensionPointId"]),
};

/**
 * One authored declaration that a field or action this Module already owns is added to
 * an extension point declared by a declared dependency. `dependency` names the dependency
 * entry by its local `dependency_key`; `extension_point` names the target's extension-point
 * key. The contribution is additive and never names the Module's own extension points.
 */
export const moduleSourceContributionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...moduleSourceContributionBase,
      kind: sourceProvenanceUnchanged(z.literal("field")),
      record_type: sourceProvenanceTarget(builderKeySchema, ["recordTypeId"]),
      field: sourceProvenanceTarget(builderKeySchema, ["fieldId"]),
    })
    .strict(),
  z
    .object({
      ...moduleSourceContributionBase,
      kind: sourceProvenanceUnchanged(z.literal("action")),
      contributed_action: sourceProvenanceTarget(sourceAliasSchema, ["actionId"]),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Module body and document.
// ---------------------------------------------------------------------------

const moduleSourceBodySchema = z
  .object({
    name: sourceProvenanceUnchanged(z.string().min(1).max(120)),
    description: sourceProvenanceUnchanged(z.string().min(1).max(1_000)),
    dependencies: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              dependency_key: sourceProvenanceUnchanged(builderKeySchema),
              module: sourceProvenanceTarget(namespacedKeySchema, [
                "moduleRootId",
                "moduleKey",
                "resolvedVersion",
              ]),
              version: sourceProvenanceUnchanged(versionRequirementSchema, true),
            })
            .strict(),
        )
        .max(100),
    ),
    record_types: sourceProvenanceUnchanged(z.array(moduleSourceRecordTypeSchema).min(1).max(100)),
    permissions: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["permissionId"]),
              key: sourceProvenanceUnchanged(namespacedKeySchema),
              label: sourceProvenanceUnchanged(labelSchema),
              description: sourceProvenanceUnchanged(z.string().min(1).max(1_000)),
              record_type: sourceProvenanceTarget(builderKeySchema.optional(), ["recordTypeId"]),
              action_kind: sourceProvenanceUnchanged(
                z.enum([
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
              ),
              named_action: sourceProvenanceUnchanged(builderKeySchema.optional()),
              administrative: sourceProvenanceUnchanged(z.boolean()),
              record_scope: sourceProvenanceUnchanged(
                moduleSourcePermissionRecordScopeSchema.optional(),
              ),
              field_policy: sourceProvenanceUnchanged(sourcePermissionFieldPolicySchema.optional()),
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
        )
        .max(100),
    ),
    actions: sourceProvenanceUnchanged(z.array(moduleSourceActionSchema).max(100)),
    events: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["eventId"]),
              key: sourceProvenanceUnchanged(namespacedKeySchema),
              record_type: sourceProvenanceTarget(builderKeySchema, ["recordTypeId"]),
              carries: sourceProvenanceUnchanged(
                z.array(sourceProvenanceTarget(builderKeySchema, ["carriedFieldIds/#"])).max(30),
              ),
              personal_or_sensitive_values_allowed: sourceProvenanceUnchanged(z.literal(false)),
            })
            .strict(),
        )
        .max(100),
    ),
    /**
     * The flows this Module owns (architecture decision 1): its save rules are flows with a
     * `BeforeSave` trigger and `transaction` execution, and its record actions and reactions are
     * flows too. Each is authored once, as the same nested task list every flow uses.
     */
    flows: sourceProvenanceUnchanged(sourceFlowCollectionSchema, true),
    extension_points: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              id: sourceProvenanceTarget(sourceAliasSchema, ["extensionPointId"]),
              key: sourceProvenanceUnchanged(builderKeySchema),
              record_type: sourceProvenanceTarget(builderKeySchema, ["recordTypeId"]),
              accepts: sourceProvenanceUnchanged(
                z.array(z.enum(["field", "action", "choice_option", "link_target"])).min(1),
              ),
            })
            .strict(),
        )
        .max(100),
    ),
    sharing_conditions: sourceProvenanceUnchanged(
      z.array(moduleSourceSharingConditionSchema).max(100),
    ),
    queries: sourceProvenanceUnchanged(z.array(moduleSourceQuerySchema).max(100).default([])),
    // Optional rather than defaulted so an authored source that declares no contributions
    // keeps the exact fingerprint it had before contributions existed.
    contributions: sourceProvenanceUnchanged(
      z.array(moduleSourceContributionSchema).max(100).optional(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    // Every named action on a system projection targets a registered protected operation, and no
    // other record type may target one; standard update is governed by the closed registry.
    const recordTypes = new Map(
      value.record_types.map((recordType) => [recordType.key, recordType]),
    );
    for (const [index, action] of value.actions.entries()) {
      const recordType = recordTypes.get(action.record_type);
      if (recordType === undefined) continue;
      const isProjection = recordType.system_projection !== undefined;
      const targetsOperation = action.protected_operation !== undefined;
      if (targetsOperation && !isProjection)
        context.addIssue({
          code: "custom",
          path: ["actions", index, "protected_operation"],
          message: "Only a system projection record type action targets a protected operation",
        });
      else if (isProjection && !targetsOperation)
        context.addIssue({
          code: "custom",
          path: ["actions", index, "tasks"],
          message:
            "A system projection record type action targets a registered protected operation",
        });
    }
    // Contributions resolve their target by a local dependency key, so a Module that
    // declares contributions needs unambiguous keys. Modules without contributions keep
    // their existing acceptance unchanged.
    if ((value.contributions ?? []).length === 0) return;
    const keys = value.dependencies.map((dependency) => dependency.dependency_key);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["dependencies"],
        message: "Module dependency keys must be unique when contributions are declared",
      });
  });

export const moduleSourceDocumentSchema = z
  .object({
    ...authoredSourceBase,
    kind: sourceProvenanceUnchanged(z.literal("module")),
    source_contract_version: sourceProvenanceUnchanged(z.literal(moduleSourceContractVersion)),
    body: sourceProvenanceUnchanged(z.preprocess(inspectSourceBounds, moduleSourceBodySchema)),
  })
  .strict();

export type ModuleSourceField = z.infer<typeof moduleSourceFieldSchema>;
export type ModuleSourceActionInput = z.infer<typeof moduleSourceActionInputSchema>;
export type ModuleSourceAction = z.infer<typeof moduleSourceActionSchema>;
export type ModuleSourceRecordType = z.infer<typeof moduleSourceRecordTypeSchema>;
export type ModuleSourceSharingCondition = z.infer<typeof moduleSourceSharingConditionSchema>;
export type ModuleSourceQuerySort = z.infer<typeof moduleSourceQuerySortSchema>;
export type ModuleSourceQueryAggregate = z.infer<typeof moduleSourceQueryAggregateSchema>;
export type ModuleSourceQuery = z.infer<typeof moduleSourceQuerySchema>;
export type ModuleSourceContribution = z.infer<typeof moduleSourceContributionSchema>;
export type ModuleSourceBody = z.infer<typeof moduleSourceBodySchema>;
export type ModuleSourceDocument = z.infer<typeof moduleSourceDocumentSchema>;
