import { z } from "zod";
import { conditionNodeSchema } from "./module-contracts";
import {
  actionInputDefinitionV2Schema,
  moduleContentV2Schema,
  moduleDraftV2Schema,
  type ActionInputDefinitionV2,
} from "./module-contracts-v2";
import { moduleSourceContractVersion as moduleSourceContractVersionV3 } from "./module-source-contracts";
import { ruleGraphSchema } from "./rule-graph-contracts";
import {
  builderKeySchema,
  fieldIdSchema,
  moduleRootIdSchema,
  queryIdSchema,
  semanticVersionSchema,
  type ModuleRootId,
  type SemanticVersion,
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

export const moduleQueryInputDefinitionV3Schema = actionInputDefinitionV2Schema;
export type ModuleQueryInputDefinitionV3 = ActionInputDefinitionV2;

export const moduleQueryDefinitionV3Schema = z
  .object({
    queryId: queryIdSchema,
    key: builderKeySchema,
    label: z.string().min(1).max(60).optional(),
    description: z.string().min(1).max(1_000).optional(),
    recordType: recordTypeReferenceSchema,
    inputs: z.array(moduleQueryInputDefinitionV3Schema).max(50),
    selectedFieldIds: z.array(fieldIdSchema).min(1).max(200),
    outputFieldIds: z.array(fieldIdSchema).min(1).max(200).optional(),
    filter: conditionNodeSchema.nullable().optional(),
    groupByFieldIds: z.array(fieldIdSchema).max(10),
    aggregates: z.array(moduleQueryAggregateSchema).max(20),
    sort: z.array(moduleQuerySortSchema).max(20),
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

export const publishedModuleQueryDescriptorV3Schema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: semanticVersionSchema,
    query: moduleQueryDefinitionV3Schema,
  })
  .strict();

export const applicationModuleQueryBindingSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: semanticVersionSchema,
    queryId: queryIdSchema,
  })
  .strict();

export const resolvePublishedModuleQuery = (
  moduleRelease: {
    rootId?: string;
    moduleRootId?: string;
    version?: string;
    releaseVersion?: string;
    content: { queries?: readonly ModuleQueryDefinitionV3[] | ModuleQueryDefinitionV3[] };
  },
  queryIdOrKey: string,
): PublishedModuleQueryDescriptorV3 | undefined => {
  const rootId = moduleRelease.rootId ?? moduleRelease.moduleRootId;
  const version = moduleRelease.version ?? moduleRelease.releaseVersion;
  if (!rootId || !version) return undefined;
  const queries = moduleRelease.content.queries ?? [];
  const match = queries.find(
    (query) => query.queryId === queryIdOrKey || query.key === queryIdOrKey,
  );
  if (!match) return undefined;
  return {
    moduleRootId: rootId as ModuleRootId,
    moduleReleaseVersion: version as SemanticVersion,
    query: match,
  };
};

export type ModuleContractVersionPairV3 = z.infer<typeof moduleContractVersionPairV3Schema>;
export type ModuleQuerySort = z.infer<typeof moduleQuerySortSchema>;
export type ModuleQueryAggregate = z.infer<typeof moduleQueryAggregateSchema>;
export type ModuleQueryDefinitionV3 = z.infer<typeof moduleQueryDefinitionV3Schema>;
export type ModuleContentV3 = z.infer<typeof moduleContentV3Schema>;
export type ModuleDraftV3 = z.infer<typeof moduleDraftV3Schema>;
export type ModuleCanonicalDocumentV3 = z.infer<typeof moduleCanonicalDocumentV3Schema>;
export type PublishedModuleQueryDescriptorV3 = z.infer<typeof publishedModuleQueryDescriptorV3Schema>;
export type ApplicationModuleQueryBinding = z.infer<typeof applicationModuleQueryBindingSchema>;
