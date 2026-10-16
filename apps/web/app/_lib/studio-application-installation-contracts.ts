import {
  applicationRootIdSchema,
  builderKeySchema,
  correlationIdSchema,
  fingerprintSchema,
  labelSchema,
  moduleInstallationBindingEvidenceSchema,
  namespacedKeySchema,
  organizationIdSchema,
  revisionSchema,
  roleIdSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
} from "@vortex/platform/schema";
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

const studioApplicationInstallationUnavailableReasonSchema = z.enum([
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

export const studioApplicationInstallationCommandResultSchema = z.union([
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
export type StudioApplicationInstallationCommandResult = z.infer<
  typeof studioApplicationInstallationCommandResultSchema
>;

const firstInstallHistoryIdentitySchema = z.object({
  draftRevision: revisionSchema,
  sourceFingerprint: fingerprintSchema,
  anchorReleaseRevision: revisionSchema.nullable(),
}).strict();

const firstInstallReleaseSchema = z.object({
  definitionKey: namespacedKeySchema,
  releaseRevision: revisionSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  validationContractVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
  moduleSetFingerprint: fingerprintSchema,
}).strict();

export const studioApplicationFirstInstallSelectorSchema = z.object({
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  releaseRevision: revisionSchema,
}).strict();

export const studioApplicationFirstInstallSnapshotSchema = z.object({
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  selected: firstInstallReleaseSchema,
  history: firstInstallHistoryIdentitySchema,
  registrationState: z.enum([
    "unprepared",
    "registration_aligned_partial",
    "provisioned_inactive",
    "active_exact",
  ]),
  registeredReleaseRevision: revisionSchema.nullable(),
  moduleBindings: z.array(moduleInstallationBindingEvidenceSchema).max(10_000),
  /** The application's default member role, offered to the installer on activation. */
  memberRole: z.object({
    sourceRoleId: roleIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    privileged: z.boolean(),
    permissions: z.array(z.object({ key: namespacedKeySchema, label: z.string().min(1).max(200) }).strict()).min(1).max(500),
  }).strict(),
}).strict();

export const studioApplicationFirstInstallLoadResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    snapshot: studioApplicationFirstInstallSnapshotSchema,
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "release_not_published",
      "already_installed",
      "installation_incomplete",
      "setup_unavailable",
      "unsupported_root",
    ]),
  }).strict(),
  z.object({ kind: z.literal("conflict") }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
]);

export const studioApplicationFirstInstallPrepareCommandSchema = z.object({
  kind: z.literal("application.first_install.prepare"),
  selector: studioApplicationFirstInstallSelectorSchema,
  expected: studioApplicationFirstInstallSnapshotSchema,
}).strict();

export const studioApplicationFirstInstallActivateCommandSchema = z.object({
  kind: z.literal("application.first_install.activate"),
  selector: studioApplicationFirstInstallSelectorSchema,
  expected: studioApplicationFirstInstallSnapshotSchema,
  /** The installer's explicit choice for the default member role shown on the install screen. */
  memberRole: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("accept"), sourceRoleId: roleIdSchema }).strict(),
    z.object({ kind: z.literal("decline") }).strict(),
  ]),
}).strict();

export const studioApplicationFirstInstallCommandResultSchema = z.union([
  z.object({
    kind: z.literal("completed"),
    action: z.literal("prepared"),
    stateMayHaveChanged: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("completed"),
    action: z.enum(["activated", "unchanged"]),
    activeAtCommitRevision: revisionSchema,
    postCommit: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("observed"), activeReleaseRevision: revisionSchema }).strict(),
      z.object({ kind: z.literal("unavailable") }).strict(),
    ]),
    stateMayHaveChanged: z.boolean(),
  }).strict(),
  z.object({
    kind: z.enum(["conflict", "refused", "authentication_required", "temporarily_unavailable", "failed"]),
    stateMayHaveChanged: z.union([z.boolean(), z.literal("unknown")]),
  }).strict(),
]);

export type StudioApplicationFirstInstallSelector = z.infer<
  typeof studioApplicationFirstInstallSelectorSchema
>;
export type StudioApplicationFirstInstallSnapshot = z.infer<
  typeof studioApplicationFirstInstallSnapshotSchema
>;
export type StudioApplicationFirstInstallLoadResult = z.infer<
  typeof studioApplicationFirstInstallLoadResultSchema
>;
export type StudioApplicationFirstInstallCommandResult = z.infer<
  typeof studioApplicationFirstInstallCommandResultSchema
>;
