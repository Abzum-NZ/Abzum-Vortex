import { z } from "zod";
import { applicationSourceDocumentV2Schema } from "./application-source-contracts";
import {
  sourceApplicationShellV2Schema,
  sourceThemeTokenValueV2Schema,
} from "./application-composition-v2";
import {
  blockIdSchema,
  builderKeySchema,
  fingerprintSchema,
  platformIdSchema,
  semanticVersionSchema,
} from "./identifiers";

const propertyMappingSchema = z
  .object({
    sourceSettingKey: builderKeySchema,
    targetPropertyKey: builderKeySchema,
  })
  .strict();

const blockMappingSchema = z
  .object({
    legacyRegistrationId: z.string().min(1),
    platformBlockId: blockIdSchema,
    platformReleaseVersion: semanticVersionSchema,
    propertyMappings: z.array(propertyMappingSchema),
  })
  .strict();

const listPageMappingSchema = z
  .object({
    pageId: z.string().min(1),
    placementId: z.string().min(1),
    platformBlockId: blockIdSchema,
    platformReleaseVersion: semanticVersionSchema,
    propertyMappings: z.array(propertyMappingSchema),
  })
  .strict();

const legacyMeaningHandlingSchema = z.discriminatedUnion("representedBy", [
  z.object({ representedBy: z.literal("base") }).strict(),
  z
    .object({
      representedBy: z.literal("overrides"),
      targetTokens: z.array(builderKeySchema).min(1),
    })
    .strict(),
]);

const themeSelectionSchema = z
  .object({
    catalogueThemeId: platformIdSchema,
    releaseVersion: semanticVersionSchema,
    legacyThemeHandling: z
      .object({
        brand: legacyMeaningHandlingSchema,
        density: legacyMeaningHandlingSchema,
        corners: legacyMeaningHandlingSchema,
        focus: legacyMeaningHandlingSchema,
      })
      .strict()
      .optional(),
    tokenOverrides: z.record(builderKeySchema, sourceThemeTokenValueV2Schema),
  })
  .strict();

const customShellSelectionSchema = z
  .object({
    pageId: z.string().min(1),
    shell: sourceApplicationShellV2Schema,
    /** Maps each source placement alias to one declared target content-slot alias. */
    contentSlots: z.record(z.string().min(1), z.string().min(1)),
    /** Maps each guided-step alias to its complete placement-to-content-slot map. */
    stepContentSlots: z
      .record(z.string().min(1), z.record(z.string().min(1), z.string().min(1)))
      .optional(),
  })
  .strict();

const selectionFields = {
  rootId: platformIdSchema,
  expectedDraftRevision: z.number().int().positive(),
  blockMappings: z.array(blockMappingSchema),
  listPageMappings: z.array(listPageMappingSchema),
  theme: themeSelectionSchema,
  customShells: z.array(customShellSelectionSchema).optional(),
};

export const prepareApplicationDraftV2ConversionCommandSchema = z.object(selectionFields).strict();
export const confirmApplicationDraftV2ConversionCommandSchema = z
  .object({
    ...selectionFields,
    preparedSourceFingerprint: fingerprintSchema,
    confirmation: z.literal("convert"),
  })
  .strict();

export const applicationDraftV2ConversionDiagnosticSchema = z
  .object({
    code: z.enum([
      "missing_mapping",
      "duplicate_mapping",
      "incompatible_property",
      "unsupported_literal",
      "incomplete_page",
      "incomplete_custom_shell",
      "stale_or_not_v1",
    ]),
    path: z.array(z.union([z.string(), z.number()])),
    alias: z.string().optional(),
  })
  .strict();

export const preparedApplicationDraftV2ConversionSchema = z
  .object({
    rootId: platformIdSchema,
    expectedDraftRevision: z.number().int().positive(),
    sourceFingerprint: fingerprintSchema,
    preparedSource: applicationSourceDocumentV2Schema,
    preparedSourceFingerprint: fingerprintSchema,
    resolvedBlocks: z.array(
      z
        .object({
          legacyRegistrationId: z.string().optional(),
          pageId: z.string().optional(),
          blockId: blockIdSchema,
          releaseVersion: semanticVersionSchema,
          contentFingerprint: fingerprintSchema,
          catalogueFingerprint: fingerprintSchema,
        })
        .strict(),
    ),
    resolvedTheme: z
      .object({
        catalogueThemeId: platformIdSchema,
        releaseVersion: semanticVersionSchema,
        contentFingerprint: fingerprintSchema,
        catalogueFingerprint: fingerprintSchema,
      })
      .strict(),
    diagnostics: z.array(applicationDraftV2ConversionDiagnosticSchema),
  })
  .strict();

export type PrepareApplicationDraftV2ConversionCommand = z.infer<
  typeof prepareApplicationDraftV2ConversionCommandSchema
>;
export type ConfirmApplicationDraftV2ConversionCommand = z.infer<
  typeof confirmApplicationDraftV2ConversionCommandSchema
>;
export type PreparedApplicationDraftV2Conversion = z.infer<
  typeof preparedApplicationDraftV2ConversionSchema
>;
