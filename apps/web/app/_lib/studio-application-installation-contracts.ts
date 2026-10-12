import {
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  correlationIdSchema,
  connectionInstanceIdSchema,
  connectionTypeIdSchema,
  fingerprintSchema,
  maximumRecoveryWindowDays,
  moduleInstallationBindingEvidenceSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  organizationLifecycleLimitsSchema,
  recordLifecyclePolicyIdSchema,
  revisionSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
  storageContractIdSchema,
  timestampSchema,
  workflowIdSchema,
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

const firstInstallSourceBindingSchema = z.object({
  moduleRootId: moduleRootIdSchema,
  moduleReleaseRevision: revisionSchema,
  bindingRevision: revisionSchema,
}).strict();

const firstInstallTargetPolicySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z.object({
    state: z.literal("configured"),
    policyId: recordLifecyclePolicyIdSchema,
    policyRevision: revisionSchema,
    policyBody: z.discriminatedUnion("action", [
      z.object({
        action: z.literal("delete"),
        maxAgeDays: z.number().int().positive().nullable(),
        maxCount: z.number().int().positive().nullable(),
        allowUnlimitedAge: z.boolean(),
        allowUnlimitedCount: z.boolean(),
        recoveryWindowDays: z.number().int().positive().max(maximumRecoveryWindowDays).optional(),
      }).strict(),
      z.object({
        action: z.literal("archive_workflow"),
        maxAgeDays: z.number().int().positive().nullable(),
        maxCount: z.number().int().positive().nullable(),
        allowUnlimitedAge: z.boolean(),
        allowUnlimitedCount: z.boolean(),
        archiveWorkflowId: workflowIdSchema,
        expectedWorkflowRevision: revisionSchema,
        archiveConnectionInstanceId: connectionInstanceIdSchema,
        archiveDestination: archiveDestinationReferenceSchema,
        expectedConnectionRevision: revisionSchema,
        expectedConnectionHealthOutcome: z.literal("healthy"),
      }).strict(),
    ]),
  }).strict(),
]);

export const studioApplicationFirstInstallTargetSchema = z.object({
  storageContractId: storageContractIdSchema,
  storageScope: z.enum(["application_contained", "organization_shared"]),
  applicationRootId: applicationRootIdSchema.nullable(),
  sourceBindings: z.array(firstInstallSourceBindingSchema).min(1).max(10_000),
  policy: firstInstallTargetPolicySchema,
}).strict();

export const studioApplicationFirstInstallSetupSchema = z.object({
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  applicationReleaseRevision: revisionSchema,
  registrationRevision: revisionSchema,
  organizationLimits: organizationLifecycleLimitsSchema,
  targets: z.array(studioApplicationFirstInstallTargetSchema).min(1).max(10_000),
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
  workflows: z.array(workflowIdSchema).max(10_000),
  setup: studioApplicationFirstInstallSetupSchema.nullable(),
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

const firstInstallPolicyFields = {
  maxAgeDays: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  maxCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  allowUnlimitedAge: z.boolean(),
  allowUnlimitedCount: z.boolean(),
};

export const studioApplicationFirstInstallPolicyInputSchema = z.discriminatedUnion("action", [
  z.object({
    ...firstInstallPolicyFields,
    action: z.literal("delete"),
    recoveryWindowDays: z.number().int().positive().max(maximumRecoveryWindowDays).optional(),
  }).strict(),
  z.object({
    ...firstInstallPolicyFields,
    action: z.literal("archive_workflow"),
    archiveWorkflowId: workflowIdSchema,
    archiveConnectionInstanceId: connectionInstanceIdSchema,
    archiveDestination: archiveDestinationReferenceSchema,
    expectedConnectionRevision: revisionSchema,
  }).strict(),
]);

export const studioApplicationFirstInstallPrepareCommandSchema = z.object({
  kind: z.literal("application.first_install.prepare"),
  selector: studioApplicationFirstInstallSelectorSchema,
  expected: studioApplicationFirstInstallSnapshotSchema,
}).strict();

export const studioApplicationFirstInstallSaveCommandSchema = z.object({
  kind: z.literal("application.first_install.save_initial_policy"),
  selector: studioApplicationFirstInstallSelectorSchema,
  expected: studioApplicationFirstInstallSnapshotSchema,
  storageContractId: storageContractIdSchema,
  targetApplicationRootId: applicationRootIdSchema.nullable(),
  expectedBindingRevision: revisionSchema,
  expectedSettingsRevision: revisionSchema,
  policy: studioApplicationFirstInstallPolicyInputSchema,
}).strict();

export const studioApplicationFirstInstallActivateCommandSchema = z.object({
  kind: z.literal("application.first_install.activate"),
  selector: studioApplicationFirstInstallSelectorSchema,
  expected: studioApplicationFirstInstallSnapshotSchema,
}).strict();

export const studioApplicationFirstInstallCommandResultSchema = z.union([
  z.object({
    kind: z.literal("completed"),
    action: z.enum(["prepared", "policy_saved"]),
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

export const studioApplicationArchiveOptionsQuerySchema = z.object({
  kind: z.literal("application.first_install.archive_options"),
  selector: studioApplicationFirstInstallSelectorSchema,
  expected: studioApplicationFirstInstallSnapshotSchema,
  storageContractId: storageContractIdSchema,
  afterConnectionInstanceId: connectionInstanceIdSchema.optional(),
}).strict();

export const studioApplicationArchiveOptionSchema = z.object({
  connectionInstanceId: connectionInstanceIdSchema,
  connectionTypeId: connectionTypeIdSchema,
  connectionTypeVersion: semanticVersionSchema,
  destinationKey: archiveDestinationReferenceSchema,
  expectedRevision: revisionSchema,
}).strict();

export const studioApplicationArchiveOptionsResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    options: z.array(studioApplicationArchiveOptionSchema).max(100),
    nextAfterConnectionInstanceId: connectionInstanceIdSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("conflict") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
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
export type StudioApplicationArchiveOptionsResult = z.infer<
  typeof studioApplicationArchiveOptionsResultSchema
>;
