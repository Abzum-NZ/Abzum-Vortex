import { z } from "zod";
import {
  actionEffectSchema,
  conditionNodeSchema,
  moduleDependencySchema,
} from "./module-contracts";
import {
  actionDefinitionV2Schema,
  actionInputDefinitionV2Schema,
  moduleContentV2Schema,
  moduleDraftV2Schema,
  recordTypeDefinitionV2Schema,
} from "./module-contracts-v2";
import { moduleSourceContractVersion as moduleSourceContractVersionV3 } from "./module-source-contracts";
import { protectedOperationReferenceSchema } from "./application-flow-bindings";
import { PLATFORM_SERVICE_OPERATIONS } from "./platform-service-operation-catalogue";
import { protectedReadModelKeySchema } from "./application-composition-v2";
import { flowSchema } from "./flow-contracts";
import { ruleGraphSchema } from "./rule-graph-contracts";
import {
  actionIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
} from "./identifiers";
import { recordTypeReferenceSchema } from "./definitions";

export const moduleValidationContractVersionV3 = "3.0.0" as const;

/** The one current Module source/validation contract pair. */
export const moduleContractVersionPairV3Schema = z
  .object({
    sourceContractVersion: z.literal(moduleSourceContractVersionV3),
    validationContractVersion: z.literal(moduleValidationContractVersionV3),
  })
  .strict();

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
    inputs: z.array(actionInputDefinitionV2Schema).max(50),
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
 * A canonical Module record type: the V2 record type extended with the optional system projection
 * storage kind. A generated-table record type carries no `systemProjection`. A system projection
 * record type is organisation scoped, refuses every standard write action, holds a required text
 * organisation field and a required whole-number revision field, and its declared filterable and
 * sortable fields are exactly its fields flagged filterable and sortable.
 */
export const recordTypeDefinitionV3Schema = recordTypeDefinitionV2Schema
  .safeExtend({
    systemProjection: moduleSystemProjectionV3Schema.optional(),
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
 * A canonical Module action: the V2 action extended with an optional registered protected operation
 * target. An action orders effects or targets one registered protected operation, never both. A
 * protected-operation action declares no effects and no identity or revision inputs, because the
 * subject record's identity and revision reach the operation automatically when it runs. It needs
 * both its own permission and the operation's registered permission: the operation re-checks the
 * actor's current authority in its owning service and never accepts an organisation or actor.
 */
export const actionDefinitionV3Schema = actionDefinitionV2Schema
  .safeExtend({
    effects: z.array(actionEffectSchema).max(10),
    protectedOperation: protectedOperationReferenceSchema.optional(),
  })
  .superRefine((value, context) => {
    const operation = value.protectedOperation;
    if ((operation !== undefined) === value.effects.length > 0)
      context.addIssue({
        code: "custom",
        path: ["protectedOperation"],
        message: "An action targets either ordered effects or one registered protected operation",
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
    ...moduleContentV2Schema.shape,
    recordTypes: z.array(recordTypeDefinitionV3Schema).min(1).max(100),
    actions: z.array(actionDefinitionV3Schema),
    flows: z.array(flowSchema).max(100),
    rules: z.array(ruleGraphSchema).max(100),
    queries: z.array(moduleQueryDefinitionV3Schema).max(100).default([]),
    contributions: z.array(moduleContributionV3Schema).max(100).optional(),
  })
  .strict();

export const moduleDraftV3Schema = moduleDraftV2Schema
  .extend({
    content: moduleContentV3Schema,
  })
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
