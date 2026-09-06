import { z } from "zod";
import { validRange } from "semver";
import { jsonValueSchema } from "./common";
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
        .refine((value) => validRange(value) !== null, "Use a valid npm semantic-version range"),
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

/**
 * Walk already-parsed contract data, not arbitrary JSON shapes.
 * JSON payloads are opaque. See https://zod.dev/packages/core#internals.
 * Unsupported structural schemas fail visibly rather than hide references.
 */
export const walkDefinitionContract = (
  schema: z.core.$ZodType,
  value: unknown,
  visit: (schema: z.core.$ZodType, value: unknown, path: PropertyKey[]) => void,
  path: PropertyKey[] = [],
): void => {
  visit(schema, value, path);
  if (schema === jsonValueSchema) return;
  if (value === null || value === undefined) return;
  const definition = (schema as z.core.$ZodTypes)._zod.def;
  const walk = (child: z.core.$ZodType, entry: unknown, childPath = path) =>
    walkDefinitionContract(child, entry, visit, childPath);
  switch (definition.type) {
    case "object":
      for (const [key, child] of Object.entries(definition.shape))
        walk(child, (value as Record<string, unknown>)[key], [...path, key]);
      return;
    case "array":
      (value as unknown[]).forEach((entry, index) =>
        walk(definition.element, entry, [...path, index]),
      );
      return;
    case "tuple":
      (value as unknown[]).forEach((entry, index) => {
        const child = definition.items[index] ?? definition.rest;
        if (child) walk(child, entry, [...path, index]);
      });
      return;
    case "record":
      for (const [key, entry] of Object.entries(value as Record<string, unknown>))
        walk(definition.valueType, entry, [...path, key]);
      return;
    case "union": {
      const discriminator =
        "discriminator" in definition && typeof definition.discriminator === "string"
          ? definition.discriminator
          : undefined;
      const option = definition.options.find((child) => {
        const childDefinition = (child as z.core.$ZodTypes)._zod.def;
        if (discriminator && childDefinition.type === "object") {
          const tag = childDefinition.shape[discriminator];
          return (
            tag !== undefined &&
            z.core.safeParse(tag, (value as Record<string, unknown>)[discriminator]).success
          );
        }
        return z.core.safeParse(child, value).success;
      });
      // The owning schema validator reports malformed branches. Never guess a
      // reference position from a value that does not match a declared branch.
      if (!option) return;
      walk(option, value);
      return;
    }
    case "lazy":
      walk(definition.getter(), value);
      return;
    case "optional":
    case "nullable":
    case "default":
    case "readonly":
      walk(definition.innerType, value);
      return;
    case "string":
    case "number":
    case "boolean":
    case "literal":
    case "enum":
    case "null":
    case "undefined":
    case "never":
      return;
    default:
      throw new Error(`Unsupported definition traversal schema: ${definition.type}`);
  }
};

export const unresolvedRecordTypeReferencePaths = (
  schema: z.core.$ZodType,
  value: unknown,
  path: PropertyKey[] = [],
): PropertyKey[][] => {
  const paths: PropertyKey[][] = [];
  walkDefinitionContract(
    schema,
    value,
    (position, entry, entryPath) => {
      if (
        position === recordTypeReferenceSchema &&
        (entry as RecordTypeReference).state === "unresolved"
      )
        paths.push(entryPath);
    },
    path,
  );
  return paths;
};

export const requireResolvedRecordTypeReferences = (
  schema: z.core.$ZodType,
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[] = [],
): void => {
  for (const referencePath of unresolvedRecordTypeReferencePaths(schema, value, path))
    context.addIssue({
      code: "custom",
      path: referencePath,
      message: "Published content cannot contain an unresolved record-type reference",
    });
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
