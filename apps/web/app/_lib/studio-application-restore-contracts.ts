import { z } from "zod";
import {
  applicationRootIdSchema,
  correlationIdSchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  revisionSchema,
  timestampSchema,
} from "@vortex/platform/schema";

const studioApplicationRestoreSelectorSchema = z.object({
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  releaseRevision: revisionSchema,
}).strict();

const studioApplicationRestoreExpectedSchema = z.object({
  draftRevision: revisionSchema.refine((revision) => revision < Number.MAX_SAFE_INTEGER),
  sourceFingerprint: fingerprintSchema,
  anchorReleaseRevision: revisionSchema,
}).strict();

/** How the viewer may see one person: named, restricted by the directory permissions, or not readable right now. */
const studioPersonLabelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("restricted") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
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
  restoredByLabel: studioPersonLabelSchema,
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

export type StudioPersonLabel = z.infer<typeof studioPersonLabelSchema>;
/** Why a restore did not run. */
export type StudioApplicationRestoreFailure = Readonly<{ kind: "refused" | "conflict" | "temporarily_unavailable" }>;
export type StudioApplicationRestoreCommand = z.infer<typeof studioApplicationRestoreCommandSchema>;
export type StudioApplicationRestoreReceipt = z.infer<typeof studioApplicationRestoreReceiptSchema>;
export type StudioApplicationRestoreCommandResult = z.infer<typeof studioApplicationRestoreCommandResultSchema>;
