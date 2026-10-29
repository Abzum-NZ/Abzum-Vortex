import { z } from "zod";
import { applicationContentSchema } from "./application-contracts";
import { correlationIdSchema } from "../catalogue/common";
import { applicationToolBundleSchema } from "./definition-compilation-contracts";
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
} from "../catalogue/identifiers";
import { moduleQueryDefinitionSchema, moduleContentSchema } from "./module-contracts";
import { applicationPlatformCompatibilityVersionSchema } from "./platform-compatibility";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";

const dependencySubject = (entry: z.infer<typeof exactDefinitionDependencySchema>): string =>
  // IDs compare lower-cased, matching the publication contract's lowercase references,
  // so casing differences cannot hide a duplicate subject or break canonical order.
  (entry.kind === "platform_theme"
    ? `${entry.kind}:${entry.catalogueThemeId}`
    : entry.kind === "platform_block"
      ? `${entry.kind}:${entry.blockId}@${entry.releaseVersion}`
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
  releaseRevision: revisionSchema,
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
export const applicationDefinitionConsumerReadResultSchema = z
  .object({
    kind: z.literal("application"),
    rootId: applicationRootIdSchema,
    content: applicationContentSchema,
    toolBundle: applicationToolBundleSchema,
    ...definitionConsumerReadResultCommon,
    validationContractVersion: z.literal("4.0.0"),
    platformCompatibilityVersion: applicationPlatformCompatibilityVersionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.toolBundle.applicationKey !== value.definitionKey)
      context.addIssue({
        code: "custom",
        path: ["toolBundle", "applicationKey"],
        message: "A consumer release's tool bundle belongs to its Definition key",
      });
  });

/** The Module 4.0.0 stored consumer projection and its exact immutable release identity. */
export const moduleDefinitionConsumerReadResultSchema = z
  .object({
    kind: z.literal("module"),
    rootId: moduleRootIdSchema,
    content: moduleContentSchema,
    ...definitionConsumerReadResultCommon,
    validationContractVersion: z.literal("4.0.0"),
  })
  .strict();

export const definitionConsumerReadResultSchema = z.discriminatedUnion("kind", [
  moduleDefinitionConsumerReadResultSchema,
  applicationDefinitionConsumerReadResultSchema,
]);

export const applicationBoundReleaseSetCommandSchema = z
  .object({ applicationReleaseRevision: revisionSchema })
  .strict();

/** Exact Application root and revision selected by a protected system consumer. */
export const systemApplicationBoundReleaseSetCommandSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

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
export const publishedModuleQueryDescriptorSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    query: moduleQueryDefinitionSchema,
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
export type ModuleDefinitionConsumerReadResult = z.infer<
  typeof moduleDefinitionConsumerReadResultSchema
>;
export type ApplicationModuleQueryBinding = z.infer<typeof applicationModuleQueryBindingSchema>;
