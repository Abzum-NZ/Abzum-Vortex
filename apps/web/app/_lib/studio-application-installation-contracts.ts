import {
  applicationRootIdSchema,
  correlationIdSchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationIdSchema,
  revisionSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "@vortex/contracts";
import { z } from "zod";

export const studioApplicationInstallationSelectorSchema = z
  .object({
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    releaseRevision: revisionSchema,
  })
  .strict();

export const studioApplicationInstallationReleaseIdentitySchema = z
  .object({
    releaseRevision: revisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    validationContractVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const studioApplicationInstallationSnapshotSchema = z
  .object({
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    definitionKey: namespacedKeySchema,
    selected: studioApplicationInstallationReleaseIdentitySchema,
    active: studioApplicationInstallationReleaseIdentitySchema,
    moduleSetFingerprint: fingerprintSchema,
    bindingSetFingerprint: fingerprintSchema,
    validUntil: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const studioApplicationInstallationUnavailableReasonSchema = z.enum([
  "not_installed",
  "not_newer",
  "module_set_changed",
  "installation_incomplete",
  "registration_misaligned",
  "unsupported_root",
]);

export const studioApplicationInstallationLoadResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      snapshot: studioApplicationInstallationSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: studioApplicationInstallationUnavailableReasonSchema,
    })
    .strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
]);

export const studioApplicationInstallationCommandSchema = z
  .object({
    kind: z.literal("application.release.install_selected"),
    selector: studioApplicationInstallationSelectorSchema,
    expected: studioApplicationInstallationSnapshotSchema,
  })
  .strict();

const postCommitObservationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observed"),
      active: studioApplicationInstallationReleaseIdentitySchema,
    })
    .strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);

export const studioApplicationInstallationCommandResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("completed"),
      outcome: z.literal("activated"),
      selected: studioApplicationInstallationReleaseIdentitySchema,
      previousActiveRevision: revisionSchema,
      activeAtCommitRevision: revisionSchema,
      postCommit: postCommitObservationSchema,
      registrationMayHaveChanged: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("completed"),
      outcome: z.literal("unchanged"),
      selected: studioApplicationInstallationReleaseIdentitySchema,
      previousActiveRevision: z.null(),
      activeAtCommitRevision: revisionSchema,
      postCommit: postCommitObservationSchema,
      registrationMayHaveChanged: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["conflict", "refused", "authentication_required", "temporarily_unavailable", "failed"]),
      registrationMayHaveChanged: z.union([z.boolean(), z.literal("unknown")]),
    })
    .strict(),
]);

export type StudioApplicationInstallationSelector = z.infer<
  typeof studioApplicationInstallationSelectorSchema
>;
export type StudioApplicationInstallationReleaseIdentity = z.infer<
  typeof studioApplicationInstallationReleaseIdentitySchema
>;
export type StudioApplicationInstallationSnapshot = z.infer<
  typeof studioApplicationInstallationSnapshotSchema
>;
export type StudioApplicationInstallationLoadResult = z.infer<
  typeof studioApplicationInstallationLoadResultSchema
>;
export type StudioApplicationInstallationCommand = z.infer<
  typeof studioApplicationInstallationCommandSchema
>;
export type StudioApplicationInstallationCommandResult = z.infer<
  typeof studioApplicationInstallationCommandResultSchema
>;
