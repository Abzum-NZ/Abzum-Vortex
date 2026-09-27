import { z } from "zod";
import { jsonValueSchema } from "./common";
import {
  applicationRootIdSchema,
  fingerprintSchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "./identifiers";

export const installationRuntimeBundleFormatVersion = 1 as const;
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

export const installationRuntimeBundleIndexSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    bundleFormatVersion: z.number().int().positive().max(2_147_483_647),
    pinFingerprint: fingerprintSchema,
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
        pages: jsonValueSchema,
        navigation: jsonValueSchema,
        flows: jsonValueSchema,
        trigger_index: jsonValueSchema,
        theme: jsonValueSchema,
        component_registry: jsonValueSchema,
        access_plan: jsonValueSchema,
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
export type InstallationRuntimeBundleIndex = z.infer<
  typeof installationRuntimeBundleIndexSchema
>;
export type InstallationRuntimeBundleKey = z.infer<
  typeof installationRuntimeBundleKeySchema
>;
export type InstallationRuntimeBundleWriteCommand = z.infer<
  typeof installationRuntimeBundleWriteCommandSchema
>;
