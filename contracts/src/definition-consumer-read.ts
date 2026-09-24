import { z } from "zod";
import { applicationContentV2Schema } from "./application-contracts";
import { correlationIdSchema } from "./common";
import { exactDefinitionDependencySchema } from "./definition-store-contracts";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  queryIdSchema,
  revisionSchema,
  semanticVersionSchema,
} from "./identifiers";
import { moduleContentV3Schema, moduleQueryDefinitionV3Schema } from "./module-contracts-v3";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const definitionConsumerReadSelectorSchema = z.discriminatedUnion("selection", [
  z.object({ selection: z.literal("current") }).strict(),
  z
    .object({ selection: z.literal("revision"), releaseRevision: javascriptSafeRevisionSchema })
    .strict(),
]);

/**
 * A consumer must select a release explicitly. `current` is discovery-only;
 * durable consumers retain and request their exact immutable release revision.
 */
export const definitionConsumerReadCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      selector: definitionConsumerReadSelectorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      selector: definitionConsumerReadSelectorSchema,
    })
    .strict(),
]);

const dependencySubject = (entry: z.infer<typeof exactDefinitionDependencySchema>): string =>
  // IDs compare lower-cased, matching the publication contract's lowercase references,
  // so casing differences cannot hide a duplicate subject or break canonical order.
  (
    entry.kind === "platform_theme"
      ? `${entry.kind}:${entry.catalogueThemeId}`
      : entry.kind === "platform_block"
        ? `${entry.kind}:${entry.blockId}`
        : entry.kind === "platform_flow"
          ? `${entry.kind}:${entry.flowId}`
          : entry.kind === "application_flow"
            ? `${entry.kind}:${entry.applicationRootId}:${entry.flowId}`
            : entry.kind === "application_flow_node"
              ? `${entry.kind}:${entry.applicationRootId}:${entry.flowId}:${entry.nodeId}`
              : entry.kind === "application_query"
                ? `${entry.kind}:${entry.applicationRootId}:${entry.queryId}`
                : entry.kind === "module_query"
                  ? `${entry.kind}:${entry.moduleRootId}:${entry.queryId}`
                  : entry.kind === "application_form"
                    ? `${entry.kind}:${entry.applicationRootId}:${entry.formId}`
                      : entry.kind === "application_workflow"
                        ? `${entry.kind}:${entry.applicationRootId}:${entry.workflowId}`
                        : entry.kind === "application_action"
                          ? `${entry.kind}:${entry.applicationRootId}:${entry.actionId}`
                          : entry.kind === "module_record_type"
                            ? `${entry.kind}:${entry.moduleRootId}:${entry.recordTypeId}`
                            : entry.kind === "module_action"
                              ? `${entry.kind}:${entry.moduleRootId}:${entry.actionId}`
                      : entry.kind === "protected_operation"
                        ? `${entry.kind}:${entry.operation.owner.kind}:${
                            entry.operation.owner.kind === "application"
                              ? entry.operation.owner.applicationRootId
                              : entry.operation.owner.kind === "module"
                                ? entry.operation.owner.moduleRootId
                                : entry.operation.owner.serviceId
                          }:${entry.operation.operationId}`
      : `${entry.kind}:${entry.key}`
  ).toLowerCase();

/** A complete manifest in canonical subject order, using the publication contract's exact entries. */
export const definitionConsumerReadDependencyManifestSchema = z
  .array(exactDefinitionDependencySchema)
  .max(10_000)
  .superRefine((entries, context) => {
    const subjects = entries.map(dependencySubject);
    if (new Set(subjects).size !== subjects.length)
      context.addIssue({
        code: "custom",
        message: "An exact dependency manifest must contain one release per subject",
      });
    if (subjects.some((subject, index) => index > 0 && subjects[index - 1]! > subject))
      context.addIssue({
        code: "custom",
        message: "An exact dependency manifest must use deterministic subject order",
      });
  });

const definitionConsumerReadResultCommon = {
  organizationId: organizationIdSchema,
  definitionKey: namespacedKeySchema,
  releaseRevision: javascriptSafeRevisionSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  validationContractVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
  dependencyManifest: definitionConsumerReadDependencyManifestSchema,
  correlationId: correlationIdSchema,
};

/**
 * The only release projection exposed to Definition-service consumers.
 * It deliberately excludes authored source, publication evidence and persistence details.
 */
export const applicationDefinitionConsumerReadResultV2Schema = z
  .object({
    kind: z.literal("application"),
    rootId: applicationRootIdSchema,
    content: applicationContentV2Schema,
    ...definitionConsumerReadResultCommon,
    validationContractVersion: z.literal("2.0.0"),
  })
  .strict();

/** The one current Module consumer-read result and exact release identity. */
export const moduleDefinitionConsumerReadResultV3Schema = z
  .object({
    kind: z.literal("module"),
    rootId: moduleRootIdSchema,
    content: moduleContentV3Schema,
    ...definitionConsumerReadResultCommon,
    validationContractVersion: z.literal("3.0.0"),
  })
  .strict();

export const definitionConsumerReadResultSchema = z.union([
  moduleDefinitionConsumerReadResultV3Schema,
  applicationDefinitionConsumerReadResultV2Schema,
]);

export const applicationBoundReleaseSetCommandSchema = z
  .object({ applicationReleaseRevision: javascriptSafeRevisionSchema })
  .strict();

/** Exact Application root and revision selected by a protected system consumer. */
export const systemApplicationBoundReleaseSetCommandSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: javascriptSafeRevisionSchema,
  })
  .strict();

const applicationDefinitionConsumerReadResultSchema =
  applicationDefinitionConsumerReadResultV2Schema;
const moduleDefinitionConsumerReadResultSchema = moduleDefinitionConsumerReadResultV3Schema;

export const applicationBoundReleaseSetResultSchema = z
  .object({
    application: applicationDefinitionConsumerReadResultSchema,
    modules: z.array(moduleDefinitionConsumerReadResultSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const roots = value.modules.map((module) => module.rootId);
    if (new Set(roots).size !== roots.length)
      context.addIssue({
        code: "custom",
        path: ["modules"],
        message: "A bound release set has one exact release per Module root",
      });
  });

/**
 * The system consumer result may be an Application with no Module dependencies.
 * The human Application-bound reader deliberately keeps its non-empty contract above.
 */
export const systemApplicationBoundReleaseSetResultSchema = z
  .object({
    application: applicationDefinitionConsumerReadResultSchema,
    modules: z.array(moduleDefinitionConsumerReadResultSchema).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const roots = value.modules.map((module) => module.rootId);
    if (new Set(roots).size !== roots.length)
      context.addIssue({
        code: "custom",
        path: ["modules"],
        message: "A system bound release set has one exact release per Module root",
      });
  });

/**
 * One published Module query with the exact release identity it was read from. This is the only
 * shape a Query executor receives; it carries the declared contract, never a database target.
 */
export const publishedModuleQueryDescriptorV3Schema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    query: moduleQueryDefinitionV3Schema,
  })
  .strict();

/** An Application selects a published Module query by module root, exact release and query identity. */
export const applicationModuleQueryBindingSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
  })
  .strict();

/**
 * Resolves a bound Application query against one exact Module release read. The binding must name
 * that release's own root and version, and the query is found only by its stable identity, so a
 * renamed key or a different release can never satisfy the binding.
 */
export const resolvePublishedModuleQuery = (
  release: ModuleDefinitionConsumerReadResultV3,
  binding: ApplicationModuleQueryBinding,
): PublishedModuleQueryDescriptorV3 | undefined => {
  if (
    release.rootId !== binding.moduleRootId ||
    release.releaseVersion !== binding.moduleReleaseVersion
  )
    return undefined;
  const query = release.content.queries.find((candidate) => candidate.queryId === binding.queryId);
  return query === undefined
    ? undefined
    : {
        moduleRootId: release.rootId,
        moduleReleaseVersion: release.releaseVersion,
        query,
      };
};

export type DefinitionConsumerReadCommand = z.infer<typeof definitionConsumerReadCommandSchema>;
export type DefinitionConsumerReadSelector = z.infer<typeof definitionConsumerReadSelectorSchema>;
export type DefinitionConsumerReadDependencyManifest = z.infer<
  typeof definitionConsumerReadDependencyManifestSchema
>;
export type DefinitionConsumerReadResult = z.infer<typeof definitionConsumerReadResultSchema>;
export type ApplicationBoundReleaseSetCommand = z.infer<
  typeof applicationBoundReleaseSetCommandSchema
>;
export type ApplicationBoundReleaseSetResult = z.infer<
  typeof applicationBoundReleaseSetResultSchema
>;
export type SystemApplicationBoundReleaseSetCommand = z.infer<
  typeof systemApplicationBoundReleaseSetCommandSchema
>;
export type SystemApplicationBoundReleaseSetResult = z.infer<
  typeof systemApplicationBoundReleaseSetResultSchema
>;
export type ModuleDefinitionConsumerReadResultV3 = z.infer<
  typeof moduleDefinitionConsumerReadResultV3Schema
>;
export type PublishedModuleQueryDescriptorV3 = z.infer<
  typeof publishedModuleQueryDescriptorV3Schema
>;
export type ApplicationModuleQueryBinding = z.infer<typeof applicationModuleQueryBindingSchema>;
