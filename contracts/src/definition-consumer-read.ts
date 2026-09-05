import { z } from "zod";
import { applicationContentV1Schema } from "./application-contracts";
import { correlationIdSchema } from "./common";
import { exactDefinitionDependencySchema } from "./definition-store-contracts";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  revisionSchema,
  semanticVersionSchema,
} from "./identifiers";
import { moduleContentSchema } from "./module-contracts";
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
  entry.kind === "platform_theme"
    ? `${entry.kind}:${entry.catalogueThemeId}`
    : `${entry.kind}:${entry.key}`;

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
export const applicationDefinitionConsumerReadResultV1Schema = z
  .object({
    kind: z.literal("application"),
    rootId: applicationRootIdSchema,
    content: applicationContentV1Schema,
    ...definitionConsumerReadResultCommon,
  })
  .strict();

export const definitionConsumerReadResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      content: moduleContentSchema,
      ...definitionConsumerReadResultCommon,
    })
    .strict(),
  applicationDefinitionConsumerReadResultV1Schema,
]);

export type DefinitionConsumerReadCommand = z.infer<typeof definitionConsumerReadCommandSchema>;
export type DefinitionConsumerReadSelector = z.infer<typeof definitionConsumerReadSelectorSchema>;
export type DefinitionConsumerReadDependencyManifest = z.infer<
  typeof definitionConsumerReadDependencyManifestSchema
>;
export type DefinitionConsumerReadResult = z.infer<typeof definitionConsumerReadResultSchema>;
