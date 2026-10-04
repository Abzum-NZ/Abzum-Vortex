import { z } from "zod";
import { compareCanonicalStrings } from "./canonical-json";
import { storedDefinitionSourceSchema } from "./definition-store-contracts";
import {
  fingerprintSchema,
  namespacedKeySchema,
  platformIdSchema,
  semanticVersionSchema,
} from "./identifiers";
import {
  organizationSetupReceiptCommandSchema,
  organizationSetupReceiptSchema,
} from "./organization-setup-receipt";

/** An original creation pair can claim pending source data, never setup authority. */
export const organizationSetupSourceManifestCommandSchema = z
  .object({
    creation: organizationSetupReceiptCommandSchema,
    expectedSetupRevision: z.literal(0),
  })
  .strict();

const sourceEntrySchema = z
  .object({
    kind: z.enum(["module", "application"]),
    key: namespacedKeySchema,
    sourceContractVersion: semanticVersionSchema.max(120),
    source: storedDefinitionSourceSchema,
    sourceFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.kind !== entry.source.kind ||
      entry.key !== entry.source.key ||
      entry.sourceContractVersion !== entry.source.source_contract_version
    )
      context.addIssue({ code: "custom", message: "Source identity does not match its document" });
  });

/** A durable initial source checkpoint is pending data, not a published authority manifest. */
export const organizationSetupSourceManifestSchema = z
  .object({
    checkpointId: platformIdSchema,
    receipt: organizationSetupReceiptSchema,
    sourceManifestIdentity: namespacedKeySchema,
    sourceManifestVersion: semanticVersionSchema.max(120),
    sources: z.array(sourceEntrySchema).min(1).max(64),
    intendedDefaultDefinitionKey: namespacedKeySchema,
    manifestFingerprint: fingerprintSchema,
    setupRevision: z.literal(1),
    phase: z.literal("source_manifest_frozen"),
  })
  .strict()
  .superRefine((manifest, context) => {
    let previousIdentity: string | undefined;
    let hasIntendedApplication = false;
    for (const entry of manifest.sources) {
      const identity = `${entry.kind}:${entry.key}`;
      if (
        previousIdentity !== undefined &&
        compareCanonicalStrings(previousIdentity, identity) >= 0
      )
        context.addIssue({ code: "custom", message: "Sources must have unique ordered identities" });
      previousIdentity = identity;
      if (entry.kind === "application" && entry.key === manifest.intendedDefaultDefinitionKey)
        hasIntendedApplication = true;
    }
    if (!hasIntendedApplication)
      context.addIssue({ code: "custom", message: "The intended default source is unavailable" });
  });

export const organizationSetupSourceManifestResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending"), manifest: organizationSetupSourceManifestSchema }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
]);

export type OrganizationSetupSourceManifestCommand = z.infer<
  typeof organizationSetupSourceManifestCommandSchema
>;
export type OrganizationSetupSourceManifest = z.infer<typeof organizationSetupSourceManifestSchema>;
export type OrganizationSetupSourceManifestResult = z.infer<
  typeof organizationSetupSourceManifestResultSchema
>;
