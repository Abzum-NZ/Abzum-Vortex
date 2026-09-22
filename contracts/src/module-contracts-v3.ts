import { z } from "zod";
import { conditionNodeSchema } from "./module-contracts";
import {
  actionInputDefinitionV2Schema,
  moduleContentV2Schema,
  moduleDraftV2Schema,
} from "./module-contracts-v2";
import { moduleSourceContractVersion as moduleSourceContractVersionV3 } from "./module-source-contracts";
import { ruleGraphSchema } from "./rule-graph-contracts";
import { builderKeySchema, fieldIdSchema, queryIdSchema } from "./identifiers";
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

export const moduleContentV3Schema = moduleContentV2Schema.extend({
  rules: z.array(ruleGraphSchema).max(100),
  queries: z.array(moduleQueryDefinitionV3Schema).max(100).default([]),
});

export const moduleDraftV3Schema = moduleDraftV2Schema.extend({
  content: moduleContentV3Schema,
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
export type ModuleContentV3 = z.infer<typeof moduleContentV3Schema>;
export type ModuleDraftV3 = z.infer<typeof moduleDraftV3Schema>;
export type ModuleCanonicalDocumentV3 = z.infer<typeof moduleCanonicalDocumentV3Schema>;
