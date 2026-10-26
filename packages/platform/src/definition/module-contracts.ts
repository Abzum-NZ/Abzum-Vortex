import { z } from "zod";
import { recordTitleFieldEligible } from "./record-title-field";
import { moduleQueryExposureSchema } from "./module-query-exposure";
import { actionInputValueTypes, sharingParameterValueTypeSchema } from "../catalogue/catalogues";
import { jsonValueSchema, labelSchema } from "../catalogue/common";
import { moduleDefinitionEnvelopeSchema, recordTypeReferenceSchema } from "./definitions";
import {
  actionIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "../catalogue/identifiers";
import {
  currencyCodeSchema,
  exactDecimalTextSchema,
  recordLinkValueSchema,
} from "../records/module-field-values";
import {
  actionTaskSchema,
  conditionNodeSchema,
  eventDefinitionSchema,
  moduleDependencySchema,
  relationshipDefinitionSchema,
} from "./module-foundation-contracts";
import { refineActionTaskIds } from "./definition-source-common";
import {
  isRegisteredWritableSystemProjection,
  moduleSourceContractVersion as moduleSourceContractVersion,
  writableSystemProjectionRegistrations,
} from "./module-source-contracts";
import { permissionDeclarationSchema } from "../access/permissions";
import { protectedOperationReferenceSchema } from "./application-flow-bindings";
import { PLATFORM_SERVICE_OPERATIONS } from "../catalogue/platform-service-operation-catalogue";
import { protectedReadModelKeySchema } from "./application-composition/protected-read-models";
import { flowSchema } from "../workflows/flow-contracts";
import { recordOwnershipModeSchema } from "../records/record-ownership-mode";
import {
  maximumRecordTypePipelines,
  pipelineShapeProblems,
  recordTypePipelineSchema,
} from "./record-type-pipelines";
export { isRegisteredWritableSystemProjection, writableSystemProjectionRegistrations };

import {
  exactRangeValid,
  formattedTextAllowedBlockSchema,
  moduleFieldSchema,
} from "./module-field-contracts";
export const moduleValidationContractVersion = "3.0.0" as const;

/** The one current Module source/validation contract pair. */
export const moduleContractVersionPairSchema = z
  .object({
    sourceContractVersion: z.literal(moduleSourceContractVersion),
    validationContractVersion: z.literal(moduleValidationContractVersion),
  })
  .strict();

const actionInputBase = {
  key: builderKeySchema,
  label: labelSchema,
  required: z.boolean(),
};
const exactActionInputValidationSchema = z
  .object({
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

export const actionInputChoiceSchema = z
  .object({ value: z.string().min(1).max(120), label: labelSchema })
  .strict();

/** A choice input lists its choices and nothing else constrains it: no pattern, no minimum length. */
export const refineCompiledTextInputChoices = (
  validation:
    | {
        choices?: readonly { value: string }[] | undefined;
        pattern?: string | undefined;
        minimumLength?: number | undefined;
        maximumLength?: number | undefined;
      }
    | undefined,
  context: z.RefinementCtx,
): void => {
  const choices = validation?.choices;
  if (validation === undefined || choices === undefined) return;
  const invalid = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: ["validation", path], message });
  if (validation.pattern !== undefined || validation.minimumLength !== undefined)
    invalid("choices", "A list of choices cannot be combined with a pattern or a minimum length");
  if (new Set(choices.map((choice) => choice.value)).size !== choices.length)
    invalid("choices", "Choice values must be unique");
  const maximumLength = validation.maximumLength;
  if (maximumLength !== undefined && choices.some((choice) => choice.value.length > maximumLength))
    invalid("maximumLength", "Every choice value must fit the maximum length");
};

export const actionInputDefinitionSchema = z
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
            choices: z.array(actionInputChoiceSchema).min(1).max(200).optional(),
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
        type: z.literal(actionInputValueTypes.whole_number),
        validation: z
          .object({
            minimum: z.number().int().safe().optional(),
            maximum: z.number().int().safe().optional(),
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
    z.object({ ...actionInputBase, type: z.literal(actionInputValueTypes.yes_no) }).strict(),
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
    if (value.type === "text") refineCompiledTextInputChoices(value.validation, context);
    if (
      value.type === "whole_number" &&
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
  .object({ key: builderKeySchema, type: sharingParameterValueTypeSchema })
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
    case "whole_number":
      return z.number().int().safe();
    case "decimal_number":
      return exactDecimalTextSchema;
    case "money":
      return z.object({ amount: exactDecimalTextSchema, currency: currencyCodeSchema }).strict();
    case "yes_no":
      return z.boolean();
    case "date":
      return z.iso.date();
    case "date_time":
      return z.iso.datetime({ offset: true });
    case "organization_account_reference":
      return organizationAccountIdSchema;
    case "record_reference":
      return recordLinkValueSchema;
  }
};

export const savedSharingConditionSchema = z
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
    operation: z.enum(["count", "sum", "minimum", "maximum", "average", "distinct_count"]),
    fieldId: fieldIdSchema.optional(),
    alias: builderKeySchema,
  })
  .strict();

/**
 * One Module-owned named query declaration. It is the same closed query contract an
 * Application already publishes, extended with typed inputs and owned by a stable query
 * identity inside an exact Module release. It never carries SQL or a database target.
 */
export const moduleQueryDefinitionSchema = z
  .object({
    queryId: queryIdSchema,
    key: builderKeySchema,
    label: z.string().min(1).max(60).optional(),
    description: z.string().min(1).max(1_000).optional(),
    exposure: moduleQueryExposureSchema,
    recordType: recordTypeReferenceSchema,
    inputs: z.array(actionInputDefinitionSchema).max(50),
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
export const moduleContributionSchema = z
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
    if (
      value.fieldId !== undefined ||
      value.recordTypeId !== undefined ||
      value.actionId === undefined
    )
      invalid("An action contribution declares exactly its contributing action", ["actionId"]);
    else if (String(value.contributionId) !== String(value.actionId))
      invalid("An action contribution is identified by its contributed action", ["contributionId"]);
  });

/**
 * The canonical system projection storage kind: the record type's typed fields project one
 * registered protected view and are read through the one query path. The canonical form resolves
 * the organisation field, the revision field and the declared filterable and sortable fields to
 * their permanent field identities.
 */
export const moduleSystemProjectionSchema = z
  .object({
    protectedView: protectedReadModelKeySchema,
    organizationFieldId: fieldIdSchema,
    revisionFieldId: fieldIdSchema,
    refreshWhile: z
      .object({
        fieldId: fieldIdSchema,
        values: z.array(z.string().min(1).max(200)).min(1).max(100),
        intervalMilliseconds: z.number().int().min(1_000).max(60_000),
      })
      .strict()
      .optional(),
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
  "link_to_one_of_several",
  "total",
  "attachment",
]);

/**
 * A canonical Module record type. A generated-table record type carries no `systemProjection`. A
 * system projection record type is organisation scoped and read-only except for a standard update
 * admitted by the closed writable-projection registration; it holds a
 * required text organisation field and a required whole-number revision field, and its declared
 * filterable and sortable fields are exactly its fields flagged filterable and sortable.
 */
export const recordTypeDefinitionSchema = z
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
    fields: z.array(moduleFieldSchema).min(1).max(500),
    relationships: z.array(relationshipDefinitionSchema),
    standardActions: z
      .array(z.enum(["create", "read", "update", "soft_delete", "restore", "export"]))
      .min(1),
    customActionIds: z.array(actionIdSchema),
    systemProjection: moduleSystemProjectionSchema.optional(),
    pipelines: z.array(recordTypePipelineSchema).max(maximumRecordTypePipelines),
  })
  .strict()
  .superRefine((value, context) => {
    const pipelineIds = new Set<string>();
    const pipelineKeys = new Set<string>();
    const stageFields = new Set<string>();
    for (const [index, pipeline] of value.pipelines.entries()) {
      const stageField = String(pipeline.stageFieldId).toLowerCase();
      if (
        pipelineIds.has(String(pipeline.pipelineId).toLowerCase()) ||
        pipelineKeys.has(pipeline.key) ||
        stageFields.has(stageField)
      )
        context.addIssue({
          code: "custom",
          path: ["pipelines", index],
          message: "Each pipeline has its own identity, key and stage field",
        });
      pipelineIds.add(String(pipeline.pipelineId).toLowerCase());
      pipelineKeys.add(pipeline.key);
      stageFields.add(stageField);
      const field = value.fields.find(
        (candidate) => String(candidate.fieldId).toLowerCase() === stageField,
      );
      const options =
        field?.type === "choice" ? field.settings.options.map((option) => option.value) : undefined;
      for (const problem of pipelineShapeProblems(pipeline, options))
        context.addIssue({
          code: "custom",
          path: ["pipelines", index, ...problem.path],
          message: problem.message,
        });
    }
  })
  .superRefine((value, context) => {
    if (value.fields.filter((field) => field.sortable).length > 8)
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message: "A record type may declare at most eight sortable fields",
      });
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
    if (
      !value.fields.some(
        (field) => field.fieldId === value.titleFieldId && recordTitleFieldEligible(field),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["titleFieldId"],
        message:
          "Title field must belong to the record type and hold a sortable text, number, choice or date value",
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
    const mayUpdate = isRegisteredWritableSystemProjection(value.key, projection.protectedView);
    if (
      value.standardActions.some(
        (action) =>
          action === "create" ||
          action === "soft_delete" ||
          action === "restore" ||
          (action === "update" && !mayUpdate),
      )
    )
      invalid(
        "A system projection standard write action must be in the closed writable registration",
        ["standardActions"],
      );
    const fields = new Map(value.fields.map((field) => [String(field.fieldId), field]));
    const organization = fields.get(String(projection.organizationFieldId));
    if (organization === undefined || organization.type !== "text" || !organization.required)
      invalid("The organisation field must be a required text field of the record type", [
        "systemProjection",
        "organizationFieldId",
      ]);
    const revision = fields.get(String(projection.revisionFieldId));
    if (projection.refreshWhile !== undefined) {
      const refresh = projection.refreshWhile;
      const field = fields.get(String(refresh.fieldId));
      if (
        field?.type !== "choice" ||
        refresh.values.some((key) => !field.settings.options.some((option) => option.value === key))
      )
        invalid("Refresh states must be choices of a field of the record type", [
          "systemProjection",
          "refreshWhile",
        ]);
    }
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
 * A canonical Module action. An action orders tasks or targets one registered protected operation,
 * never both. A protected-operation action declares no tasks and no identity or revision inputs,
 * because the subject record's identity and revision reach the operation automatically when it
 * runs. It needs both its own permission and the operation's registered permission: the operation
 * re-checks the actor's current authority in its owning service and never accepts an organisation
 * or actor.
 */
export const actionDefinitionSchema = z
  .object({
    actionId: actionIdSchema,
    key: namespacedKeySchema,
    label: labelSchema,
    subjectRecordTypeId: recordTypeIdSchema,
    permissionKey: namespacedKeySchema.optional(),
    permissionKeys: z.array(namespacedKeySchema).min(2).optional(),
    sharing: z.enum(["refused", "allowed"]),
    inputs: z.array(actionInputDefinitionSchema).max(50),
    precondition: conditionNodeSchema.optional(),
    tasks: z.array(actionTaskSchema).max(10).superRefine(refineActionTaskIds),
    protectedOperation: protectedOperationReferenceSchema.optional(),
    /** The choice field and option this action sets, so a plain save of that option runs it. */
    setsChoiceFieldId: fieldIdSchema.optional(),
    setsChoiceOption: z.string().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.setsChoiceFieldId === undefined) !== (value.setsChoiceOption === undefined))
      context.addIssue({
        code: "custom",
        path: ["setsChoiceOption"],
        message: "An action names the choice field and the option it sets together",
      });
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
 * every save rule is a flow with a `BeforeSave` trigger and `transaction` execution, and the
 * save transaction runs it with the flow interpreter.
 */
export const moduleContentSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    /** The one Application that owns this Module; every other Application uses it by name. */
    ownerApplication: namespacedKeySchema,
    dependencies: z.array(moduleDependencySchema),
    recordTypes: z.array(recordTypeDefinitionSchema).max(100),
    permissions: z.array(permissionDeclarationSchema),
    actions: z.array(actionDefinitionSchema),
    events: z.array(eventDefinitionSchema),
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
    flows: z.array(flowSchema).max(100),
    queries: z.array(moduleQueryDefinitionSchema).max(100).default([]),
    contributions: z.array(moduleContributionSchema).max(100).optional(),
  })
  .strict();

export const moduleDraftSchema = z
  .object({ envelope: moduleDefinitionEnvelopeSchema, content: moduleContentSchema })
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
    // Every named action on a system projection targets a registered protected operation, and no
    // other record type's action may target one; standard update is governed by the closed registry.
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

export type ActionInputDefinition = z.infer<typeof actionInputDefinitionSchema>;
export type ModuleQueryDefinition = z.infer<typeof moduleQueryDefinitionSchema>;
export type RecordTypeDefinition = z.infer<typeof recordTypeDefinitionSchema>;
export type ModuleContribution = z.infer<typeof moduleContributionSchema>;
export type ModuleContent = z.infer<typeof moduleContentSchema>;
export type ModuleDraft = z.infer<typeof moduleDraftSchema>;
