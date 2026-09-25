import { z } from "zod";
import { conditionNodeSchema, moduleDependencySchema } from "./module-contracts";
import {
  actionInputDefinitionV2Schema,
  moduleContentV2Schema,
  moduleDraftV2Schema,
} from "./module-contracts-v2";
import { moduleSourceContractVersion as moduleSourceContractVersionV3 } from "./module-source-contracts";
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
 * A Module's canonical content. `flows` is the one home of its behaviour (architecture decision 1):
 * every save rule is a flow with a `BeforeSave` trigger and `transaction` execution.
 *
 * `rules` is not authored. It is the executable form of exactly those `BeforeSave` flows, derived
 * from them by the compiler, because the database read that hands a save its rules and the
 * before-save evaluator still read a rule graph. Until the flow interpreter replaces them (#1007),
 * every `BeforeSave` flow has exactly one rule of the same identity, record type and priority, and
 * no rule exists without its flow, so a save can never run without a rule its Module declares.
 */
export const moduleContentV3Schema = moduleContentV2Schema.extend({
  flows: z.array(flowSchema).max(100),
  rules: z.array(ruleGraphSchema).max(100),
  queries: z.array(moduleQueryDefinitionV3Schema).max(100).default([]),
  contributions: z.array(moduleContributionV3Schema).max(100).optional(),
});

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
export type ModuleContributionV3 = z.infer<typeof moduleContributionV3Schema>;
export type ModuleContentV3 = z.infer<typeof moduleContentV3Schema>;
export type ModuleDraftV3 = z.infer<typeof moduleDraftV3Schema>;
export type ModuleCanonicalDocumentV3 = z.infer<typeof moduleCanonicalDocumentV3Schema>;
