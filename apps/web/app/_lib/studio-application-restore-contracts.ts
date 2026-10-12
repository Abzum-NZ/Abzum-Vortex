import { z } from "zod";
import {
  applicationRootIdSchema,
  correlationIdSchema,
  definitionReleaseMetadataSchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "@vortex/contracts";

export const studioApplicationRestoreSelectorSchema = z.object({
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  releaseRevision: revisionSchema,
}).strict();

const studioApplicationRestoreExpectedSchema = z.object({
  draftRevision: revisionSchema.refine((revision) => revision < Number.MAX_SAFE_INTEGER),
  sourceFingerprint: fingerprintSchema,
  anchorReleaseRevision: revisionSchema,
}).strict();

const studioApplicationRestoreSnapshotSchema = z.object({
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  definitionKey: namespacedKeySchema,
  ...studioApplicationRestoreExpectedSchema.shape,
}).strict();

const studioApplicationRestoreAvailableSchema = z.object({
  kind: z.literal("available"),
  selector: studioApplicationRestoreSelectorSchema,
  snapshot: studioApplicationRestoreSnapshotSchema,
  metadata: definitionReleaseMetadataSchema,
}).strict().superRefine((result, refinement) => {
  if (result.snapshot.organizationId.toLowerCase() !== result.selector.organizationId.toLowerCase() ||
    result.snapshot.rootId.toLowerCase() !== result.selector.rootId.toLowerCase()) {
    refinement.addIssue({ code: "custom", path: ["snapshot"], message: "Restore snapshot does not match its selector" });
  }
  if (result.selector.releaseRevision > result.snapshot.anchorReleaseRevision ||
    result.metadata.releaseRevision !== result.selector.releaseRevision ||
    result.metadata.isCurrent !== (result.metadata.releaseRevision === result.snapshot.anchorReleaseRevision)) {
    refinement.addIssue({ code: "custom", path: ["metadata"], message: "Restore metadata does not match the current snapshot" });
  }
});

const studioApplicationRestoreFailureSchema = z.object({
  kind: z.enum(["refused", "conflict", "temporarily_unavailable"]),
}).strict();

export const studioApplicationRestoreLoadResultSchema = z.union([
  studioApplicationRestoreAvailableSchema,
  studioApplicationRestoreFailureSchema,
]);

export const studioApplicationRestoreCommandSchema = z.object({
  selector: studioApplicationRestoreSelectorSchema,
  expected: studioApplicationRestoreExpectedSchema,
  confirmed: z.literal(true),
}).strict().superRefine((command, refinement) => {
  if (command.selector.releaseRevision > command.expected.anchorReleaseRevision) {
    refinement.addIssue({ code: "custom", path: ["selector", "releaseRevision"], message: "Restore target is beyond the shown publication anchor" });
  }
});

export const studioApplicationRestoreReceiptSchema = z.object({
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  definitionKey: namespacedKeySchema,
  targetReleaseRevision: revisionSchema,
  draftRevision: revisionSchema,
  sourceFingerprint: fingerprintSchema,
  publicationAnchor: revisionSchema,
  restoredBy: organizationAccountIdSchema,
  restoredAt: timestampSchema,
  correlationId: correlationIdSchema,
}).strict();

export const studioApplicationRestoreCommandResultSchema = z.union([
  z.object({
    kind: z.literal("completed"),
    receipt: studioApplicationRestoreReceiptSchema,
    stateMayHaveChanged: z.literal(true),
  }).strict(),
  z.object({
    kind: z.enum(["refused", "conflict", "temporarily_unavailable"]),
    stateMayHaveChanged: z.union([z.literal(false), z.literal("unknown")]),
  }).strict(),
]);

export type StudioApplicationRestoreSelector = z.infer<typeof studioApplicationRestoreSelectorSchema>;
type StudioApplicationRestoreExpected = z.infer<typeof studioApplicationRestoreExpectedSchema>;
type StudioApplicationRestoreSnapshot = z.infer<typeof studioApplicationRestoreSnapshotSchema>;
export type StudioApplicationRestoreAvailable = z.infer<typeof studioApplicationRestoreAvailableSchema>;
export type StudioApplicationRestoreFailure = z.infer<typeof studioApplicationRestoreFailureSchema>;
export type StudioApplicationRestoreLoadResult = z.infer<typeof studioApplicationRestoreLoadResultSchema>;
export type StudioApplicationRestoreCommand = z.infer<typeof studioApplicationRestoreCommandSchema>;
export type StudioApplicationRestoreReceipt = z.infer<typeof studioApplicationRestoreReceiptSchema>;
export type StudioApplicationRestoreCommandResult = z.infer<typeof studioApplicationRestoreCommandResultSchema>;
