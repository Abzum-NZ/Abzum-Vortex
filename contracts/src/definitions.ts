import { z } from "zod";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "./identifiers";

export const definitionKindSchema = z.enum(["module", "application"]);

const draftMetadata = {
  organizationId: organizationIdSchema,
  key: namespacedKeySchema,
  draftRevision: revisionSchema,
  publishedRevision: revisionSchema.optional(),
  createdAt: timestampSchema,
  createdBy: actorIdSchema,
  updatedAt: timestampSchema,
  updatedBy: actorIdSchema,
};

export const moduleDefinitionEnvelopeSchema = z
  .object({ kind: z.literal("module"), rootId: moduleRootIdSchema, ...draftMetadata })
  .strict();

export const applicationDefinitionEnvelopeSchema = z
  .object({ kind: z.literal("application"), rootId: applicationRootIdSchema, ...draftMetadata })
  .strict();

export const definitionEnvelopeSchema = z.discriminatedUnion("kind", [
  moduleDefinitionEnvelopeSchema,
  applicationDefinitionEnvelopeSchema,
]);

const publishedMetadata = {
  revision: revisionSchema,
  releaseVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  publishedAt: timestampSchema,
  publishedBy: actorIdSchema,
  validationContractVersion: semanticVersionSchema,
};

export const publishedModuleReferenceSchema = z
  .object({ kind: z.literal("module"), rootId: moduleRootIdSchema, ...publishedMetadata })
  .strict();

export const publishedApplicationReferenceSchema = z
  .object({ kind: z.literal("application"), rootId: applicationRootIdSchema, ...publishedMetadata })
  .strict();

export const publishedDefinitionReferenceSchema = z.discriminatedUnion("kind", [
  publishedModuleReferenceSchema,
  publishedApplicationReferenceSchema,
]);

export const containedComponentReferenceSchema = z.discriminatedUnion("ownerKind", [
  z
    .object({
      ownerKind: z.literal("module"),
      ownerRootId: moduleRootIdSchema,
      componentKind: builderKeySchema,
      componentId: containedComponentIdSchema,
      key: builderKeySchema,
    })
    .strict(),
  z
    .object({
      ownerKind: z.literal("application"),
      ownerRootId: applicationRootIdSchema,
      componentKind: builderKeySchema,
      componentId: containedComponentIdSchema,
      key: builderKeySchema,
    })
    .strict(),
]);

export const versionRequirementSchema = z.discriminatedUnion("selection", [
  z.object({ selection: z.literal("exact"), version: semanticVersionSchema }).strict(),
  z
    .object({
      selection: z.literal("allowed_range"),
      expression: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[0-9A-Za-z.*+<>=~^| -]+$/),
    })
    .strict(),
]);

export const qualifiedRecordTypeKeySchema = z
  .string()
  .max(81)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*:[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    "Use module_key:record_type_key",
  );

export const unresolvedRecordTypeReferenceSchema = z
  .object({ state: z.literal("unresolved"), qualifiedKey: qualifiedRecordTypeKeySchema })
  .strict();

export const resolvedRecordTypeReferenceSchema = z
  .object({
    state: z.literal("resolved"),
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
  })
  .strict();

export const recordTypeReferenceSchema = z.discriminatedUnion("state", [
  unresolvedRecordTypeReferenceSchema,
  resolvedRecordTypeReferenceSchema,
]);

export const requireResolvedRecordTypeReferences = (
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[] = [],
): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      requireResolvedRecordTypeReferences(entry, context, [...path, index]),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<PropertyKey, unknown>;
  if (record.state === "unresolved" && typeof record.qualifiedKey === "string") {
    context.addIssue({
      code: "custom",
      path,
      message: "Published content cannot contain an unresolved record-type reference",
    });
    return;
  }
  for (const key of Reflect.ownKeys(record))
    requireResolvedRecordTypeReferences(record[key], context, [...path, key]);
};

export type DefinitionKind = z.infer<typeof definitionKindSchema>;
export type ModuleDefinitionEnvelope = z.infer<typeof moduleDefinitionEnvelopeSchema>;
export type ApplicationDefinitionEnvelope = z.infer<typeof applicationDefinitionEnvelopeSchema>;
export type DefinitionEnvelope = z.infer<typeof definitionEnvelopeSchema>;
export type PublishedModuleReference = z.infer<typeof publishedModuleReferenceSchema>;
export type PublishedApplicationReference = z.infer<typeof publishedApplicationReferenceSchema>;
export type PublishedDefinitionReference = z.infer<typeof publishedDefinitionReferenceSchema>;
export type ContainedComponentReference = z.infer<typeof containedComponentReferenceSchema>;
export type VersionRequirement = z.infer<typeof versionRequirementSchema>;
export type QualifiedRecordTypeKey = z.infer<typeof qualifiedRecordTypeKeySchema>;
export type UnresolvedRecordTypeReference = z.infer<typeof unresolvedRecordTypeReferenceSchema>;
export type ResolvedRecordTypeReference = z.infer<typeof resolvedRecordTypeReferenceSchema>;
export type RecordTypeReference = z.infer<typeof recordTypeReferenceSchema>;
export type ResolveRecordTypeReferences<T> = T extends UnresolvedRecordTypeReference
  ? never
  : T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends readonly (infer Item)[]
      ? ResolveRecordTypeReferences<Item>[]
      : T extends object
        ? { [Key in keyof T]: ResolveRecordTypeReferences<T[Key]> }
        : T;
