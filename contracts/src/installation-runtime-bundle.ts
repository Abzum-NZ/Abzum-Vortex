import { z } from "zod";
import { applicationContentV2Schema } from "./application-contracts";
import { placementSlotV2Schema } from "./application-composition-v2";
import { jsonValueSchema } from "./common";
import {
  applicationDefinitionConsumerReadResultV2Schema,
  moduleDefinitionConsumerReadResultV3Schema,
  type SystemApplicationBoundReleaseSetResult,
} from "./definition-consumer-read";
import {
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  pageIdSchema,
  permissionIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  semanticVersionSchema,
  storageContractIdSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "./identifiers";
import { recordOwnershipModeSchema } from "./record-ownership-compatibility";
import {
  permissionActionKindSchema,
  permissionDeclarationSchema,
  permissionRecordScopeSchema,
} from "./permissions";
import {
  recordStorageColumnTokenSchema,
  recordStorageTableTokenSchema,
} from "./storage";
import { savedSharingConditionV3Schema } from "./module-contracts-v3";

export {
  resolvePageComposition,
  type PlacementSlotV2,
  type ResolvedPageComposition,
} from "./runtime-bundle-page-composition";
export const installationRuntimeBundleFormatVersion = 2 as const;
export const installationRuntimeBundleMaximumPartBytes = 1_048_575;

export const installationRuntimeBundleSections = [
  "pages",
  "navigation",
  "flows",
  "trigger_index",
  "theme",
  "component_registry",
  "access_plan",
  "tool_bundle",
] as const;

export const installationRuntimeBundleSectionSchema = z.enum(
  installationRuntimeBundleSections,
);

export const installationRuntimeBundlePartMetadataSchema = z
  .object({
    section: installationRuntimeBundleSectionSchema,
    ordinal: z.number().int().nonnegative().max(2_147_483_647),
    byteSize: z.number().int().positive().max(installationRuntimeBundleMaximumPartBytes),
    sha256: fingerprintSchema,
  })
  .strict();

export const installationRuntimeBundlePartSchema =
  installationRuntimeBundlePartMetadataSchema.extend({
    /** A UTF-8 fragment of the section's canonical JSON serialization. */
    content: z.string(),
  }).strict();

const immutableRuntimeReleaseIdentitySchema = z.object({
  rootId: z.uuid(),
  definitionKey: namespacedKeySchema,
  releaseRevision: revisionSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  validationContractVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
}).strict();

const immutableRuntimeModuleIdentitySchema = immutableRuntimeReleaseIdentitySchema.extend({
  rootId: moduleRootIdSchema,
}).strict();

const applicationConsumerResultFields = applicationDefinitionConsumerReadResultV2Schema.shape;
const moduleConsumerResultFields = moduleDefinitionConsumerReadResultV3Schema.shape;
const applicationContentFields = z.object(applicationContentV2Schema.shape).strict();

// Release metadata is immutable; consumer correlation IDs are request-specific and are injected
// again when a HUMAN release set is reconstructed from the stored sections.
const installationRuntimeBundleApplicationSourceHeaderSchema = z
  .object(applicationConsumerResultFields)
  .omit({ content: true, toolBundle: true, correlationId: true })
  .strict();

const installationRuntimeBundleModuleSourceHeaderSchema = z
  .object(moduleConsumerResultFields)
  .omit({ content: true, correlationId: true })
  .strict();

const installationRuntimeBundleApplicationPageContentSchema = applicationContentFields
  .omit({
    navigation: true,
    flows: true,
    flowBindings: true,
    theme: true,
    platformBlockDependencies: true,
    pages: true,
    shells: true,
  })
  .strict();

const installationRuntimeBundleResolvedRootsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), main: placementSlotV2Schema }).strict(),
  z
    .object({
      kind: z.literal("guided"),
      stepContent: z.record(z.string(), placementSlotV2Schema),
    })
    .strict(),
]);

export const installationRuntimeBundlePagesSectionSchema = z
  .object({
    application: z
      .object({
        identity: installationRuntimeBundleApplicationSourceHeaderSchema,
        content: installationRuntimeBundleApplicationPageContentSchema,
        shells: applicationContentFields.shape.shells,
        pages: applicationContentFields.shape.pages,
      })
      .strict(),
    modules: z
      .array(
        z
          .object({
            identity: installationRuntimeBundleModuleSourceHeaderSchema,
            content: moduleConsumerResultFields.content,
          })
          .strict(),
      )
      .max(10_000)
      .superRefine((modules, context) => {
        const roots = modules.map((module) => module.identity.rootId.toLowerCase());
        if (new Set(roots).size !== roots.length)
          context.addIssue({
            code: "custom",
            message: "A runtime page section must contain one release per Module root",
          });
        if (roots.some((root, index) => index > 0 && roots[index - 1]! >= root))
          context.addIssue({
            code: "custom",
            message: "Runtime page Module releases must use strict root order",
          });
      }),
    resolvedCompositions: z.array(
      z
        .object({
          pageId: pageIdSchema,
          roots: installationRuntimeBundleResolvedRootsSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const pageIds = value.application.pages.map((page) => page.pageId);
    const compositionPageIds = value.resolvedCompositions.map(
      (composition) => composition.pageId,
    );
    if (
      pageIds.length !== compositionPageIds.length ||
      pageIds.some((pageId, index) => compositionPageIds[index] !== pageId)
    )
      context.addIssue({
        code: "custom",
        path: ["resolvedCompositions"],
        message: "Runtime page compositions must match the exact source page order",
      });
    if (
      value.modules.some(
        (module) =>
          module.identity.organizationId !== value.application.identity.organizationId,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["modules"],
        message: "Runtime page Module releases must belong to the exact Application organization",
      });
  });

const runtimePlanFieldTypeSchema = z.enum([
  "text",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
  "table",
  "link",
  "link_to_one_of_several",
  "link_to_person",
  "calculation",
  "total",
  "attachment",
]);

const runtimePlanFieldSchema = z.object({
  fieldId: fieldIdSchema,
  type: runtimePlanFieldTypeSchema,
  settings: z.record(z.string(), jsonValueSchema),
}).strict();

const runtimePlanColumnSchema = z.object({
  token: recordStorageColumnTokenSchema,
  databaseValueType: z.enum([
    "boolean",
    "date",
    "decimal",
    "integer",
    "json",
    "text",
    "timestamp_with_time_zone",
    "uuid",
  ]),
  type: runtimePlanFieldTypeSchema,
}).strict();

const runtimePlanRecordTypeSchema = z.object({
  moduleRootId: moduleRootIdSchema,
  recordTypeId: recordTypeIdSchema,
  storageContractId: storageContractIdSchema,
  storageScope: z.enum(["organization_shared", "application_contained"]),
  ownershipMode: recordOwnershipModeSchema,
  releaseRevision: revisionSchema,
  validationContractVersion: semanticVersionSchema,
  table: recordStorageTableTokenSchema,
  columns: z.record(fieldIdSchema, runtimePlanColumnSchema),
  valueExpression: z.string(),
  fields: z.array(runtimePlanFieldSchema).min(1).max(500),
  ownershipRelationshipId: containedComponentIdSchema.optional(),
}).strict();

const runtimePlanRelationshipSchema = z.object({
  relationshipId: containedComponentIdSchema,
  fromModuleRootId: moduleRootIdSchema,
  fromRecordTypeId: recordTypeIdSchema,
  toRecordTypes: z.array(z.object({
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
  }).strict()).min(1).max(20),
}).strict();

const runtimePlanPermissionSchema = z.discriminatedUnion("ownerKind", [
  z.object({
    ownerKind: z.literal("application"),
    ownerId: applicationRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    actionKind: permissionActionKindSchema,
    namedAction: builderKeySchema.nullable(),
    recordScope: permissionRecordScopeSchema,
  }).strict(),
  z.object({
    ownerKind: z.literal("module"),
    ownerId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    actionKind: permissionActionKindSchema,
    namedAction: builderKeySchema.nullable(),
    recordScope: permissionRecordScopeSchema,
  }).strict(),
]);

const runtimePlanRecordTypesSchema = z
  .record(recordTypeIdSchema, runtimePlanRecordTypeSchema)
  .superRefine((values, context) => {
    for (const [key, value] of Object.entries(values))
      if (key !== value.recordTypeId.toLowerCase())
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Runtime Record plan key must match its canonical Record type identity",
        });
  });

const runtimePlanRelationshipsSchema = z
  .record(containedComponentIdSchema, runtimePlanRelationshipSchema)
  .superRefine((values, context) => {
    for (const [key, value] of Object.entries(values))
      if (key !== value.relationshipId.toLowerCase())
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Runtime Record plan key must match its canonical relationship identity",
        });
  });

const runtimePlanPermissionsSchema = z
  .record(permissionIdSchema, runtimePlanPermissionSchema)
  .superRefine((values, context) => {
    for (const key of Object.keys(values))
      if (key !== key.toLowerCase())
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Runtime Record plan permission keys must use canonical UUID order",
        });
  });

const runtimeRecordAccessPlanSchema = z.object({
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  applicationReleaseRevision: revisionSchema,
  recordTypes: runtimePlanRecordTypesSchema,
  relationships: runtimePlanRelationshipsSchema,
  sharingConditions: z.array(savedSharingConditionV3Schema),
  permissions: runtimePlanPermissionsSchema,
}).strict();

export const installationPreparedRecordAccessPlanSchema = z.object({
  planKey: fingerprintSchema,
  mappingFingerprint: fingerprintSchema,
  plan: runtimeRecordAccessPlanSchema,
}).strict();

export const installationRuntimeBundleAccessPlanSectionSchema = z.object({
  preparedRecordAccessPlan: installationPreparedRecordAccessPlanSchema,
  declaredPermissions: z.object({
    application: z.array(permissionDeclarationSchema),
    modules: z.array(z.object({
      rootId: moduleRootIdSchema,
      permissions: z.array(permissionDeclarationSchema),
    }).strict()).max(10_000),
  }).strict(),
}).strict();

/** Exact protected source identities and immutable prepared Record plan for format 2. */
export const installationRuntimeBundleSourceManifestSchema = z.object({
  bundleFormatVersion: z.literal(installationRuntimeBundleFormatVersion),
  application: immutableRuntimeReleaseIdentitySchema.extend({
    rootId: applicationRootIdSchema,
  }).strict(),
  modules: z.array(immutableRuntimeModuleIdentitySchema).max(10_000).superRefine((modules, context) => {
    const roots = modules.map((module) => module.rootId.toLowerCase());
    if (new Set(roots).size !== roots.length)
      context.addIssue({
        code: "custom",
        message: "A runtime source manifest must contain one release per Module root",
      });
    if (roots.some((root, index) => index > 0 && roots[index - 1]! >= root))
      context.addIssue({
        code: "custom",
        message: "Runtime source Module identities must be in strict root order",
      });
  }),
  pinFingerprint: fingerprintSchema,
  preparedRecordAccessPlan: z.object({
    planKey: fingerprintSchema,
    mappingFingerprint: fingerprintSchema,
  }).strict(),
}).strict();
export const installationRuntimeBundleIndexSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    bundleFormatVersion: z.literal(installationRuntimeBundleFormatVersion),
    pinFingerprint: fingerprintSchema,
    sourceManifest: installationRuntimeBundleSourceManifestSchema,
    parts: z.array(installationRuntimeBundlePartMetadataSchema).min(
      installationRuntimeBundleSections.length,
    ),
    totalSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    builtAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    let totalSizeBytes = 0;
    for (const section of installationRuntimeBundleSections) {
      const sectionParts = value.parts
        .filter((part) => part.section === section)
        .sort((left, right) => left.ordinal - right.ordinal);
      if (sectionParts.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["parts"],
          message: "Every runtime bundle section must have a part",
        });
        continue;
      }
      sectionParts.forEach((part, ordinal) => {
        if (part.ordinal !== ordinal)
          context.addIssue({
            code: "custom",
            path: ["parts"],
            message: "Runtime bundle part ordinals must be contiguous from zero",
          });
        totalSizeBytes += part.byteSize;
      });
    }
    if (
      value.sourceManifest.bundleFormatVersion !== value.bundleFormatVersion ||
      value.sourceManifest.application.rootId !== value.applicationRootId ||
      value.sourceManifest.application.releaseRevision !== value.applicationReleaseRevision ||
      value.sourceManifest.pinFingerprint !== value.pinFingerprint
    )
      context.addIssue({
        code: "custom",
        path: ["sourceManifest"],
        message: "Runtime source manifest must identify this exact format-2 bundle",
      });
    if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes !== value.totalSizeBytes)
      context.addIssue({
        code: "custom",
        path: ["totalSizeBytes"],
        message: "Runtime bundle total size must equal the sum of its parts",
      });
  });

export const installationRuntimeBundleKeySchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    bundleFormatVersion: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export const installationRuntimeBundleWriteCommandSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    bundleFormatVersion: z.literal(installationRuntimeBundleFormatVersion),
    pinFingerprint: fingerprintSchema,
    sections: z
      .object({
        pages: installationRuntimeBundlePagesSectionSchema,
        navigation: jsonValueSchema,
        flows: jsonValueSchema,
        trigger_index: jsonValueSchema,
        theme: jsonValueSchema,
        component_registry: jsonValueSchema,
        access_plan: installationRuntimeBundleAccessPlanSectionSchema,
        tool_bundle: jsonValueSchema,
      })
      .strict(),
  })
  .strict();

export const installationRuntimeBundleReadPartsCommandSchema = z
  .object({
    ...installationRuntimeBundleKeySchema.shape,
    sections: z.array(installationRuntimeBundleSectionSchema).min(1).max(
      installationRuntimeBundleSections.length,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.sections).size !== value.sections.length)
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "A section may be requested only once",
      });
  });

export type InstallationRuntimeBundleSection =
  (typeof installationRuntimeBundleSections)[number];
export type InstallationRuntimeBundlePartMetadata = z.infer<
  typeof installationRuntimeBundlePartMetadataSchema
>;
export type InstallationRuntimeBundlePart = z.infer<
  typeof installationRuntimeBundlePartSchema
>;
export type InstallationRuntimeBundleSourceManifest = z.infer<
  typeof installationRuntimeBundleSourceManifestSchema
>;
export type InstallationPreparedRecordAccessPlan = z.infer<
  typeof installationPreparedRecordAccessPlanSchema
>;
export type PreparedInstallationRuntimeSource = Readonly<{
  releaseSet: SystemApplicationBoundReleaseSetResult;
  sourceManifest: InstallationRuntimeBundleSourceManifest;
  preparedRecordAccessPlan: InstallationPreparedRecordAccessPlan;
}>;
export type InstallationRuntimeBundleIndex = z.infer<
  typeof installationRuntimeBundleIndexSchema
>;
export type InstallationRuntimeBundleKey = z.infer<
  typeof installationRuntimeBundleKeySchema
>;
export type InstallationRuntimeBundleWriteCommand = z.infer<
  typeof installationRuntimeBundleWriteCommandSchema
>;






