import { z } from "zod";
import {
  builderKeySchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  permissionIdSchema,
  recordTypeIdSchema,
  sourceQualifiedRecordTypeSchema,
} from "../catalogue/identifiers";
import { descriptionSchema, jsonValueSchema, labelSchema } from "../catalogue/common";
import {
  authoredSourceBase,
  refineActionTaskIds,
  sourceActionTaskSchema,
  sourceAliasSchema,
  sourceConditionSchema,
  sourceQualifiedRelationshipSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "./definition-source-common";
import {
  sourceExactDecimalTextSchema,
  sourceMoneyValueSchema,
} from "../records/module-field-values";
import { moduleSourceRecordOwnershipModeSchema } from "../records/record-ownership-compatibility";
import { sourceFlowCollectionSchema } from "../workflows/flow-source-contracts";
import {
  boundedProtectedReadModelSortKeys,
  protectedReadModelKeySchema,
} from "./application-composition/protected-read-models";
import { PLATFORM_SERVICE_OPERATIONS } from "../catalogue/platform-service-operation-catalogue";
import {
  permissionActionKindSchema,
  permissionFieldPolicySchema,
  permissionRecordScopeSchema,
} from "../access/permissions";
import { moduleSourceFieldSchema } from "./module-source-fields";
import { moduleSourceActionInputSchema } from "./module-source-action-inputs";

/** The one current Module source/validation contract pair. */
export const moduleSourceContractVersion = "3.0.0" as const;

/** The closed set of protected projections that may declare the standard update action. */
export const writableSystemProjectionRegistrations = Object.freeze({
  organization_settings: Object.freeze({
    moduleKey: "vortex.organisation_administration",
    protectedView: "organization_runtime_settings",
  }),
} as const);

/** A declaration kept by a platform system-module source for creation-time platform registration. */
export const modulePlatformPermissionDeclarationSchema = z
  .object({
    pinnedPermissionId: permissionIdSchema.optional(),
    key: namespacedKeySchema,
    label: labelSchema,
    description: descriptionSchema,
    recordTypeId: recordTypeIdSchema.optional(),
    actionKind: permissionActionKindSchema,
    namedAction: builderKeySchema.optional(),
    administrative: z.boolean(),
    recordScope: permissionRecordScopeSchema.optional(),
    fieldPolicy: permissionFieldPolicySchema.optional(),
    stewardMinimum: z.boolean().optional(),
    meaningFingerprint: fingerprintSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.actionKind === "named") !== (value.namedAction !== undefined))
      context.addIssue({
        code: "custom",
        path: ["namedAction"],
        message: "Named actions are present only for the named action kind",
      });
    if (value.fieldPolicy !== undefined && value.recordTypeId === undefined)
      context.addIssue({
        code: "custom",
        path: ["fieldPolicy"],
        message: "Only record permissions may declare a field policy",
      });
  });

export type ModulePlatformPermissionDeclaration = z.infer<
  typeof modulePlatformPermissionDeclarationSchema
>;

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

const sourcePermissionRecordScopeRouteSchema = z.discriminatedUnion("kind", [
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

const sourcePermissionRecordScopeBaseSchema = z
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
const moduleSourceProtectedOperationKeySchema = z.enum(systemRecordProtectedOperationKeys);

/**
 * The system projection storage kind: the record type's typed fields project one registered
 * protected view (or the function behind it) rather than generated record storage. The projection
 * includes the organisation, so the declaration names the field that holds it; filterable and
 * sortable fields are the closed subset the query engine may use; and the revision field is the
 * concurrency number every protected operation re-checks.
 */
const moduleSourceSystemProjectionSchema = z
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
 * Field types whose values cannot be supplied by a protected view. A read-only
 * typed link can be projected as a value without writing a relationship edge.
 */
const systemProjectionRefusedFieldTypes: ReadonlySet<string> = new Set([
  "reference_number",
  "table",
  "link_to_one_of_several",
  "total",
  "attachment",
]);

const moduleSourceRecordTypeSchema = z
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
    if (value.fields.filter((field) => field.sortable).length > 8)
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message: "A record type may declare at most eight sortable fields",
      });
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
      value.standard_actions.some(
        (action) =>
          action === "create" ||
          action === "soft_delete" ||
          action === "restore" ||
          (action === "update" && !mayUpdate),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["standard_actions"],
        message:
          "A system projection standard write action must be in the closed writable registration",
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
    const readerSortKeys = boundedProtectedReadModelSortKeys[projection.protected_view];
    for (const [index, key] of projection.sortable_fields.entries())
      if (readerSortKeys !== undefined && !readerSortKeys.includes(key))
        context.addIssue({
          code: "custom",
          path: ["system_projection", "sortable_fields", index],
          message: `Protected projection reader ${projection.protected_view} does not accept sort key ${key}`,
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

const moduleSourceActionSchema = z
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
    sets_choice_field: sourceProvenanceTarget(builderKeySchema.optional(), ["setsChoiceFieldId"]),
    sets_choice_option: sourceProvenanceUnchanged(z.string().min(1).max(120).optional()),
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
    if ((value.sets_choice_field === undefined) !== (value.sets_choice_option === undefined))
      context.addIssue({
        code: "custom",
        path: ["sets_choice_option"],
        message: "An action names the choice field and the option it sets together",
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
  decimal_number: sourceExactDecimalTextSchema,
  money: sourceMoneyValueSchema,
  boolean: z.boolean(),
  date: z.iso.date(),
  date_time: z.iso.datetime({ offset: true }),
  organization_account_reference: organizationAccountIdSchema,
};

const moduleSourceSharingConditionSchema = z
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

const moduleSourceQuerySortSchema = z
  .object({
    field: sourceProvenanceTarget(builderKeySchema, ["fieldId"]),
    direction: sourceProvenanceUnchanged(z.enum(["ascending", "descending"])),
  })
  .strict();

const moduleSourceQueryAggregateSchema = z
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
const moduleSourceQuerySchema = z
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
const moduleSourceContributionSchema = z.discriminatedUnion("kind", [
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

/** The fields every Module body declares, inline in an Application or as its internal release unit. */
const moduleSourceBodyFields = {
  name: sourceProvenanceUnchanged(z.string().min(1).max(120)),
  description: sourceProvenanceUnchanged(z.string().min(1).max(1_000)),
  record_types: sourceProvenanceUnchanged(z.array(moduleSourceRecordTypeSchema).max(100)),
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
};

type ModuleSourceBodyFields = z.infer<z.ZodObject<typeof moduleSourceBodyFields>>;

const refineModuleSourceBody = (value: ModuleSourceBodyFields, context: z.RefinementCtx): void => {
  // Every named action on a system projection targets a registered protected operation, and no
  // other record type may target one; standard update is governed by the closed registry.
  const recordTypes = new Map(value.record_types.map((recordType) => [recordType.key, recordType]));
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
        message: "A system projection record type action targets a registered protected operation",
      });
  }
};

/**
 * One Module authored inside its Application source (`modules`). The Module key is global: one
 * Application owns it, and any other Application that needs it names it in `uses`. A Module never
 * declares its dependencies: the compiler derives them from the qualified references it makes to
 * its sibling Modules and to the Modules its Application uses.
 */
export const sourceApplicationModuleSchema = z
  .object({
    id: sourceProvenanceUnchanged(sourceAliasSchema),
    key: sourceProvenanceUnchanged(namespacedKeySchema),
    ...moduleSourceBodyFields,
  })
  .strict()
  .superRefine(refineModuleSourceBody);

export type SourceApplicationModule = z.infer<typeof sourceApplicationModuleSchema>;

/**
 * The internal Module release unit derived from an Application's inline Module: exactly the same
 * body plus its owning Application. It is never authored, and holds no dependencies: the compiler
 * derives those from its references every time (`moduleDependencies`).
 */
const moduleSourceBodySchema = z
  .object({
    ...moduleSourceBodyFields,
    owner_application: sourceProvenanceUnchanged(namespacedKeySchema),
    // Optional rather than defaulted so an authored source that declares no contributions
    // keeps the exact fingerprint it had before contributions existed.
    contributions: sourceProvenanceUnchanged(
      z.array(moduleSourceContributionSchema).max(100).optional(),
    ),
  })
  .strict()
  .superRefine(refineModuleSourceBody);

export const moduleSourceDocumentSchema = z
  .object({
    ...authoredSourceBase,
    kind: sourceProvenanceUnchanged(z.literal("module")),
    source_contract_version: sourceProvenanceUnchanged(z.literal(moduleSourceContractVersion)),
    body: sourceProvenanceUnchanged(z.preprocess(inspectSourceBounds, moduleSourceBodySchema)),
  })
  .strict();

export type ModuleSourceDocument = z.infer<typeof moduleSourceDocumentSchema>;
