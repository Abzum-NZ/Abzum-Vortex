import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  organizationIdSchema,
  organizationLifecycleLimitsSchema,
  recordLifecycleActionSchema,
  recordTypeLifecyclePolicySchema,
  revisionSchema,
  storageContractIdSchema,
  workflowIdSchema,
  type IdentitySession,
  type OrganizationLifecycleLimits,
  type OrganizationSelectionCandidate,
  type RecordTypeLifecyclePolicy,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

/**
 * Common age/count fields shared by every record-type lifecycle policy
 * action. Mirrors the closed-representation invariant already enforced by
 * `recordTypeLifecyclePolicySchema` in contracts/src/record-lifecycle-policy.ts:
 * an explicit finite ceiling or an explicit unlimited permission, never both
 * and never a silent missing-limit fallback.
 */
type RecordTypeLifecyclePolicyCommonFields = Readonly<{
  maxAgeDays: number | null;
  maxCount: number | null;
  allowUnlimitedAge: boolean;
  allowUnlimitedCount: boolean;
}>;

export type RecordTypeLifecyclePolicyActionInput =
  | (RecordTypeLifecyclePolicyCommonFields & Readonly<{ action: "delete" }>)
  | (RecordTypeLifecyclePolicyCommonFields &
      Readonly<{
        action: "archive_workflow";
        archiveWorkflowId: string;
        expectedWorkflowRevision: number;
        archiveConnectionInstanceId: string;
        archiveDestination: string;
        expectedConnectionRevision: number;
        expectedDestinationFingerprint: string;
        expectedConnectionHealthOutcome: "healthy";
      }>);

/**
 * Accepts exact organisation, storage-contract/application scope, policy
 * body and expected organisation/policy revisions. `policyId` is never part
 * of this command: it is server-assigned and immutable across revisions.
 */
export interface SaveRecordTypeLifecyclePolicyCommand {
  readonly organizationId: string;
  readonly storageContractId: string;
  readonly applicationRootId: string | null;
  /** Must match the organisation's current lifecycle-limits revision. */
  readonly expectedSettingsRevision: number;
  /** `null` when creating the first policy for this exact target. */
  readonly expectedPolicyRevision: number | null;
  readonly policy: RecordTypeLifecyclePolicyActionInput;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const parseSafeRevision = (value: unknown) =>
  revisionSchema.max(Number.MAX_SAFE_INTEGER).safeParse(value);

const parseNullablePositiveInteger = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return undefined;
};

const parseCommonLifecycleFields = (
  candidate: Readonly<Record<string, unknown>>,
): RecordTypeLifecyclePolicyCommonFields | undefined => {
  const maxAgeDays = parseNullablePositiveInteger(candidate.maxAgeDays);
  const maxCount = parseNullablePositiveInteger(candidate.maxCount);
  if (
    maxAgeDays === undefined ||
    maxCount === undefined ||
    typeof candidate.allowUnlimitedAge !== "boolean" ||
    typeof candidate.allowUnlimitedCount !== "boolean" ||
    (candidate.allowUnlimitedAge && maxAgeDays !== null) ||
    (!candidate.allowUnlimitedAge && maxAgeDays === null) ||
    (candidate.allowUnlimitedCount && maxCount !== null) ||
    (!candidate.allowUnlimitedCount && maxCount === null)
  )
    return undefined;
  return {
    maxAgeDays,
    maxCount,
    allowUnlimitedAge: candidate.allowUnlimitedAge,
    allowUnlimitedCount: candidate.allowUnlimitedCount,
  };
};

const hasOnlyKeys = (candidate: Readonly<Record<string, unknown>>, allowed: readonly string[]) =>
  Object.keys(candidate).every((key) => allowed.includes(key));

const deletePolicyKeys = [
  "action",
  "maxAgeDays",
  "maxCount",
  "allowUnlimitedAge",
  "allowUnlimitedCount",
] as const;

const archiveWorkflowPolicyKeys = [
  ...deletePolicyKeys,
  "archiveWorkflowId",
  "expectedWorkflowRevision",
  "archiveConnectionInstanceId",
  "archiveDestination",
  "expectedConnectionRevision",
  "expectedDestinationFingerprint",
  "expectedConnectionHealthOutcome",
] as const;

const saveCommandKeys = [
  "organizationId",
  "storageContractId",
  "applicationRootId",
  "expectedSettingsRevision",
  "expectedPolicyRevision",
  "policy",
] as const;

const parseRecordTypeLifecyclePolicyActionInput = (
  candidate: unknown,
): RecordTypeLifecyclePolicyActionInput | undefined => {
  if (!isPlainObject(candidate)) return undefined;
  const action = recordLifecycleActionSchema.safeParse(candidate.action);
  if (!action.success) return undefined;
  const common = parseCommonLifecycleFields(candidate);
  if (common === undefined) return undefined;

  if (action.data === "delete") {
    if (!hasOnlyKeys(candidate, deletePolicyKeys)) return undefined;
    return { action: "delete", ...common };
  }

  if (!hasOnlyKeys(candidate, archiveWorkflowPolicyKeys)) return undefined;
  const archiveWorkflowId = workflowIdSchema.safeParse(candidate.archiveWorkflowId);
  const expectedWorkflowRevision = parseSafeRevision(candidate.expectedWorkflowRevision);
  const archiveConnectionInstanceId = connectionInstanceIdSchema.safeParse(
    candidate.archiveConnectionInstanceId,
  );
  const archiveDestination = archiveDestinationReferenceSchema.safeParse(
    candidate.archiveDestination,
  );
  const expectedConnectionRevision = parseSafeRevision(candidate.expectedConnectionRevision);
  const expectedDestinationFingerprint =
    typeof candidate.expectedDestinationFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.expectedDestinationFingerprint)
      ? candidate.expectedDestinationFingerprint
      : undefined;
  if (
    !archiveWorkflowId.success ||
    !expectedWorkflowRevision.success ||
    !archiveConnectionInstanceId.success ||
    !archiveDestination.success ||
    !expectedConnectionRevision.success ||
    expectedDestinationFingerprint === undefined ||
    candidate.expectedConnectionHealthOutcome !== "healthy"
  )
    return undefined;

  return {
    action: "archive_workflow",
    ...common,
    archiveWorkflowId: archiveWorkflowId.data,
    expectedWorkflowRevision: expectedWorkflowRevision.data,
    archiveConnectionInstanceId: archiveConnectionInstanceId.data,
    archiveDestination: archiveDestination.data,
    expectedConnectionRevision: expectedConnectionRevision.data,
    expectedDestinationFingerprint,
    expectedConnectionHealthOutcome: "healthy",
  };
};

const parseSaveRecordTypeLifecyclePolicyCommand = (
  candidate: unknown,
): SaveRecordTypeLifecyclePolicyCommand | undefined => {
  if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, saveCommandKeys)) return undefined;
  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const storageContractId = storageContractIdSchema.safeParse(candidate.storageContractId);
  const applicationRootId =
    candidate.applicationRootId === null
      ? { success: true as const, data: null }
      : applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const expectedSettingsRevision = parseSafeRevision(candidate.expectedSettingsRevision);
  const expectedPolicyRevision =
    candidate.expectedPolicyRevision === null
      ? { success: true as const, data: null }
      : parseSafeRevision(candidate.expectedPolicyRevision);
  const policy = parseRecordTypeLifecyclePolicyActionInput(candidate.policy);

  if (
    !organizationId.success ||
    !storageContractId.success ||
    !applicationRootId.success ||
    !expectedSettingsRevision.success ||
    !expectedPolicyRevision.success ||
    policy === undefined
  )
    return undefined;

  return {
    organizationId: organizationId.data,
    storageContractId: storageContractId.data,
    applicationRootId: applicationRootId.data,
    expectedSettingsRevision: expectedSettingsRevision.data,
    expectedPolicyRevision: expectedPolicyRevision.data,
    policy,
  };
};

const requireOneRow = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("RECORD_LIFECYCLE_POLICY_STORAGE_UNAVAILABLE");
  return rows[0];
};

type LimitsRow = DatabaseRow & { limits: unknown };

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface RecordLifecycleLimitsStoreDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

/**
 * Trusted explicit setup for organisation lifecycle ceilings. Like Identity's
 * `initializeOrganizationRuntimeSettings`, it can create revision 1 or return
 * an identical retry, but it cannot mutate an existing organisation's limits.
 */
export const createOrganizationLifecycleLimitsStore = (
  dependencies: RecordLifecycleLimitsStoreDependencies = {},
) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  return Object.freeze({
    async initialize(limitsCandidate: unknown): Promise<OrganizationLifecycleLimits> {
      const limits = organizationLifecycleLimitsSchema.safeParse(limitsCandidate);
      if (
        !limits.success ||
        limits.data.settingsRevision !== 1 ||
        (limits.data.maxRetentionDays !== null &&
          limits.data.maxRetentionDays !== undefined &&
          !Number.isSafeInteger(limits.data.maxRetentionDays)) ||
        (limits.data.maxRecordCount !== null &&
          limits.data.maxRecordCount !== undefined &&
          !Number.isSafeInteger(limits.data.maxRecordCount))
      )
        throw new Error("INVALID_ORGANIZATION_LIFECYCLE_LIMITS");

      const canonicalLimits: OrganizationLifecycleLimits = {
        ...limits.data,
        maxRetentionDays: limits.data.maxRetentionDays ?? null,
        maxRecordCount: limits.data.maxRecordCount ?? null,
      };

      return runtimeTransaction(async (transaction) => {
        const rows = await transaction.query<LimitsRow>`
          select vortex_record.initialize_organization_lifecycle_limits(
            ${canonicalLimits.organizationId}::uuid,
            ${JSON.stringify(canonicalLimits)}::text::jsonb
          ) as limits
        `;
        const row = requireOneRow(rows);
        const stored = organizationLifecycleLimitsSchema.safeParse(row.limits);
        if (
          !stored.success ||
          !sameUuid(stored.data.organizationId, canonicalLimits.organizationId) ||
          stored.data.settingsRevision !== 1 ||
          stored.data.maxRetentionDays !== canonicalLimits.maxRetentionDays ||
          stored.data.maxRecordCount !== canonicalLimits.maxRecordCount ||
          stored.data.allowUnlimitedRetentionDays !==
            canonicalLimits.allowUnlimitedRetentionDays ||
          stored.data.allowUnlimitedRecordCount !== canonicalLimits.allowUnlimitedRecordCount ||
          stored.data.allowedActions.length !== canonicalLimits.allowedActions.length ||
          stored.data.allowedActions.some(
            (action, index) => action !== canonicalLimits.allowedActions[index],
          ) ||
          stored.data.allowedArchiveDestinations.length !==
            canonicalLimits.allowedArchiveDestinations.length ||
          stored.data.allowedArchiveDestinations.some(
            (destination, index) =>
              destination !== canonicalLimits.allowedArchiveDestinations[index],
          )
        )
          throw new Error("RECORD_LIFECYCLE_POLICY_STORAGE_UNAVAILABLE");
        return stored.data;
      });
    },
  });
};

type PolicyRow = DatabaseRow & { policy: unknown };

export type RecordTypeLifecyclePolicyServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ activityId?: () => string }>;

const storedPolicyMatchesCommand = (
  stored: RecordTypeLifecyclePolicy,
  submitted: RecordTypeLifecyclePolicyActionInput,
): boolean =>
  stored.action === submitted.action &&
  stored.maxAgeDays === submitted.maxAgeDays &&
  stored.maxCount === submitted.maxCount &&
  stored.allowUnlimitedAge === submitted.allowUnlimitedAge &&
  stored.allowUnlimitedCount === submitted.allowUnlimitedCount &&
  (stored.action === "delete" ||
    (submitted.action === "archive_workflow" &&
      sameUuid(stored.archiveWorkflowId, submitted.archiveWorkflowId) &&
      stored.expectedWorkflowRevision === submitted.expectedWorkflowRevision &&
      sameUuid(stored.archiveConnectionInstanceId, submitted.archiveConnectionInstanceId) &&
      stored.archiveDestination === submitted.archiveDestination &&
      stored.expectedConnectionRevision === submitted.expectedConnectionRevision &&
      stored.expectedDestinationFingerprint === submitted.expectedDestinationFingerprint &&
      stored.expectedConnectionHealthOutcome === submitted.expectedConnectionHealthOutcome));

/**
 * Protected current record-type lifecycle policy storage (#566). Reuses the
 * existing `human-organization-request` current-human-organisation-
 * administration context and the exact `recordTypeLifecyclePolicySchema` /
 * `organizationLifecycleLimitsSchema` contracts; it does not implement #567
 * activation/recovery integration or #568 preview/removal handoff.
 */
export const createRecordTypeLifecyclePolicyService = (
  dependencies: RecordTypeLifecyclePolicyServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newActivityId = dependencies.activityId ?? randomUUID;

  return Object.freeze({
    save: async (
      session: IdentitySession,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordTypeLifecyclePolicy>> => {
      const command = parseSaveRecordTypeLifecyclePolicyCommand(commandCandidate);
      if (command === undefined) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      const selection: OrganizationSelectionCandidate =
        command.applicationRootId === null
          ? { organizationId: command.organizationId }
          : {
              organizationId: command.organizationId,
              applicationRootId: command.applicationRootId,
            };

      return requests.runChange(session, selection, async (transaction, scope) => {
        // Every vortex_record write primitive (transfer_record_ownership,
        // save-record, named-action storage) is granted execute only to
        // vortex_runtime; the request-role transaction re-elevates to it
        // immediately before the call, the same as those existing callers.
        await transaction.query`set local role vortex_runtime`;
        const rows = await transaction.query<PolicyRow>`
          select vortex_record.save_record_type_lifecycle_policy_for_administration(
            ${command.storageContractId}::uuid,
            ${command.applicationRootId}::uuid,
            ${command.expectedSettingsRevision}::bigint,
            ${command.expectedPolicyRevision}::bigint,
            ${activityId}::uuid,
            ${JSON.stringify(command.policy)}::text::jsonb
          ) as policy
        `;
        const row = requireOneRow(rows);
        const parsed = recordTypeLifecyclePolicySchema.safeParse(row.policy);
        const expectedRevision = (command.expectedPolicyRevision ?? 0) + 1;
        if (
          !parsed.success ||
          !sameUuid(parsed.data.organizationId, scope.organizationId) ||
          !sameUuid(parsed.data.storageContractId, command.storageContractId) ||
          (parsed.data.applicationRootId === null) !== (command.applicationRootId === null) ||
          (parsed.data.applicationRootId !== null &&
            command.applicationRootId !== null &&
            !sameUuid(parsed.data.applicationRootId, command.applicationRootId)) ||
          parsed.data.policyRevision !== expectedRevision ||
          !storedPolicyMatchesCommand(parsed.data, command.policy)
        )
          throw new Error("RECORD_LIFECYCLE_POLICY_STORAGE_UNAVAILABLE");
        return parsed.data;
      });
    },
  });
};
