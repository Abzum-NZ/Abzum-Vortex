import { z } from "zod";
import {
  applicationRootIdSchema,
  containedComponentIdSchema,
  fingerprintSchema,
  lineageIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  packageIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  semanticVersionSchema,
  storageContractIdSchema,
} from "./identifiers";

export const packageLineageReferenceSchema = z
  .object({
    lineageId: lineageIdSchema,
    packageId: packageIdSchema,
    publisherOrganizationId: organizationIdSchema,
    sourceModuleRootId: moduleRootIdSchema,
    sourceRecordTypeId: recordTypeIdSchema,
    sourceStorageContractId: storageContractIdSchema,
    sourceReleaseVersion: semanticVersionSchema,
    sourceContentFingerprint: fingerprintSchema,
    localOrganizationId: organizationIdSchema,
    localApplicationRootId: applicationRootIdSchema.optional(),
    localModuleRootId: moduleRootIdSchema,
    localRecordTypeId: recordTypeIdSchema,
    localPublishedRevision: revisionSchema,
    componentMappings: z
      .array(
        z
          .object({
            sourceComponentId: containedComponentIdSchema,
            localComponentId: containedComponentIdSchema,
          })
          .strict(),
      )
      .min(1),
    mappingFingerprint: fingerprintSchema,
  })
  .strict();

const compatibilityEvidenceSchema = z
  .object({
    signedPackageVerified: z.literal(true),
    compatibilityState: z.literal("compatible"),
    sourceStorageFingerprint: fingerprintSchema,
    localStorageFingerprint: fingerprintSchema,
    mappingFingerprint: fingerprintSchema,
  })
  .strict();

const preserveStorageLineageSchema = z
  .object({
    decision: z.literal("preserve_source_storage"),
    lineage: packageLineageReferenceSchema,
    selectedStorageContractId: storageContractIdSchema,
    evidence: compatibilityEvidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selectedStorageContractId !== value.lineage.sourceStorageContractId) {
      context.addIssue({
        code: "custom",
        path: ["selectedStorageContractId"],
        message: "Selected storage must be the proven source storage contract",
      });
    }
    if (value.evidence.sourceStorageFingerprint !== value.evidence.localStorageFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "localStorageFingerprint"],
        message: "Stored meaning is not compatible",
      });
    }
    if (value.evidence.mappingFingerprint !== value.lineage.mappingFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "mappingFingerprint"],
        message: "Mapping evidence does not match the installed lineage",
      });
    }
  });

const allocateStorageLineageSchema = z
  .object({
    decision: z.literal("allocate_new_storage"),
    allocatedStorageContractId: storageContractIdSchema,
    reason: z.enum([
      "independent_definition",
      "structural_fork",
      "incompatible_meaning",
      "unproven_lineage",
    ]),
    sourceStorageContractId: storageContractIdSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.sourceStorageContractId === undefined ||
      value.sourceStorageContractId !== value.allocatedStorageContractId,
    {
      path: ["allocatedStorageContractId"],
      message: "New storage identity must differ from the source",
    },
  );

export const storageLineageDecisionSchema = z.union([
  preserveStorageLineageSchema,
  allocateStorageLineageSchema,
]);

export type PackageLineageReference = z.infer<typeof packageLineageReferenceSchema>;
export type StorageLineageDecision = z.infer<typeof storageLineageDecisionSchema>;
