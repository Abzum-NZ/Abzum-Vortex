import "server-only";

import { randomUUID } from "node:crypto";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  activityIdSchema,
  recordTypeLifecyclePolicySchema,
  sameId,
  type ApplicationRootId,
  type ConnectionInstanceId,
  type OrganizationId,
  type RecordTypeLifecyclePolicy,
  type StorageContractId,
  type SystemApplicationBoundReleaseSetResult,
  type WorkflowId,
} from "../schema";
import { InstallationArchiveConnectionError } from "./installation-archive-connections";
import type { EligibleArchiveConnectionOption } from "../connections/connection-instance-reader";

export type InitialLifecyclePolicyInput =
  | Readonly<{
      action: "delete";
      maxAgeDays: number | null;
      maxCount: number | null;
      allowUnlimitedAge: boolean;
      allowUnlimitedCount: boolean;
      recoveryWindowDays?: number | undefined;
    }>
  | Readonly<{
      action: "archive_workflow";
      maxAgeDays: number | null;
      maxCount: number | null;
      allowUnlimitedAge: boolean;
      allowUnlimitedCount: boolean;
      archiveWorkflowId: WorkflowId;
      archiveConnectionInstanceId: ConnectionInstanceId;
      archiveDestination: string;
      expectedConnectionRevision: number;
    }>;

export type InitialLifecyclePolicyTarget = Readonly<{
  organizationId: OrganizationId;
  installationRootId: ApplicationRootId;
  releaseRevision: number;
  storageContractId: StorageContractId;
  applicationRootId: ApplicationRootId | null;
}>;

const unexpectedStoredPolicy = (detail: string): never => {
  throw new InstallationArchiveConnectionError("temporarily_unavailable", detail);
};

export const workflowIsInExactRelease = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  applicationRootId: string,
  workflowId: string,
): boolean =>
  releaseSet.application.dependencyManifest.some(
    (dependency) =>
      dependency.kind === "application_workflow" &&
      sameId(dependency.applicationRootId, applicationRootId) &&
      sameId(dependency.workflowId, workflowId),
  );

export const initialLifecyclePolicyMatches = (
  storedCandidate: unknown,
  target: InitialLifecyclePolicyTarget,
  input: InitialLifecyclePolicyInput,
  expectedConnectionFingerprint?: string,
): RecordTypeLifecyclePolicy => {
  const parsed = recordTypeLifecyclePolicySchema.safeParse(storedCandidate);
  if (!parsed.success) return unexpectedStoredPolicy("stored_policy_unreadable");
  const stored = parsed.data;
  if (
    !sameId(stored.organizationId, target.organizationId) ||
    !sameId(stored.storageContractId, target.storageContractId) ||
    (stored.applicationRootId === null) !== (target.applicationRootId === null) ||
    (stored.applicationRootId !== null &&
      target.applicationRootId !== null &&
      !sameId(stored.applicationRootId, target.applicationRootId))
  )
    return unexpectedStoredPolicy("stored_policy_target_mismatch");
  if (
    stored.policyRevision !== 1 ||
    stored.action !== input.action ||
    stored.maxAgeDays !== input.maxAgeDays ||
    stored.maxCount !== input.maxCount ||
    stored.allowUnlimitedAge !== input.allowUnlimitedAge ||
    stored.allowUnlimitedCount !== input.allowUnlimitedCount
  )
    return unexpectedStoredPolicy("stored_policy_limits_mismatch");
  if (stored.action === "delete") {
    if (input.action !== "delete" || stored.recoveryWindowDays !== input.recoveryWindowDays)
      return unexpectedStoredPolicy("stored_policy_recovery_window_mismatch");
  } else if (
    input.action !== "archive_workflow" ||
    expectedConnectionFingerprint === undefined ||
    !sameId(stored.archiveWorkflowId, input.archiveWorkflowId) ||
    stored.expectedWorkflowRevision !== target.releaseRevision ||
    !sameId(stored.archiveConnectionInstanceId, input.archiveConnectionInstanceId) ||
    stored.archiveDestination !== input.archiveDestination ||
    stored.expectedConnectionRevision !== input.expectedConnectionRevision ||
    stored.expectedDestinationFingerprint !== expectedConnectionFingerprint ||
    stored.expectedConnectionHealthOutcome !== "healthy"
  )
    return unexpectedStoredPolicy("stored_policy_archive_mismatch");
  return stored;
};

export const saveInitialArchiveWorkflowPolicy = async (
  transaction: RequestDatabaseTransaction,
  target: InitialLifecyclePolicyTarget,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  sourceBindingRevisions: readonly number[],
  expectedBindingRevision: number,
  expectedSettingsRevision: number,
  input: Extract<InitialLifecyclePolicyInput, { action: "archive_workflow" }>,
  option: EligibleArchiveConnectionOption,
): Promise<RecordTypeLifecyclePolicy> => {
  if (
    target.applicationRootId === null ||
    !workflowIsInExactRelease(releaseSet, target.installationRootId, input.archiveWorkflowId)
  )
    throw new InstallationArchiveConnectionError("refused", "archive_workflow_not_in_release");
  if (sourceBindingRevisions.filter((revision) => revision === expectedBindingRevision).length !== 1)
    throw new InstallationArchiveConnectionError("conflict", "binding_revision_changed");
  const policy = {
    action: "archive_workflow" as const,
    maxAgeDays: input.maxAgeDays,
    maxCount: input.maxCount,
    allowUnlimitedAge: input.allowUnlimitedAge,
    allowUnlimitedCount: input.allowUnlimitedCount,
    archiveWorkflowId: input.archiveWorkflowId,
    expectedWorkflowRevision: target.releaseRevision,
    archiveConnectionInstanceId: option.connectionInstanceId,
    archiveDestination: option.destinationKey,
    expectedConnectionRevision: option.expectedRevision,
    expectedDestinationFingerprint: option.destinationFingerprint,
    expectedConnectionHealthOutcome: "healthy" as const,
  };
  const activityId = activityIdSchema.parse(randomUUID());
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<DatabaseRow>`
    select vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(
      ${target.installationRootId}::uuid,
      ${expectedBindingRevision}::bigint,
      ${target.storageContractId}::uuid,
      ${target.applicationRootId}::uuid,
      ${expectedSettingsRevision}::bigint,
      ${activityId}::uuid,
      ${JSON.stringify(policy)}::text::jsonb
    ) as policy
  `;
  if (rows.length !== 1)
    throw new InstallationArchiveConnectionError("temporarily_unavailable", "save_returned_no_policy");
  return initialLifecyclePolicyMatches(rows[0]?.policy, target, input, option.destinationFingerprint);
};
