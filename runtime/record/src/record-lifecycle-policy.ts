import "server-only";

import { randomUUID } from "node:crypto";
import {
  sameId,
  activityIdSchema,
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  maximumRecoveryWindowDays,
  moduleRootIdSchema,
  organizationIdSchema,
  organizationLifecycleLimitsSchema,
  organizationAccessDeclarationSchema,
  recordLifecyclePolicyIdSchema,
  recordLifecycleActionSchema,
  recordTypeLifecyclePolicySchema,
  revisionSchema,
  sessionContextSchema,
  storageContractIdSchema,
  timestampSchema,
  workflowIdSchema,
  databaseTimestamp,
  type ApplicationRootId,
  type IdentitySession,
  type ModuleRootId,
  type OrganizationAccessDecision,
  type OrganizationId,
  type StorageContractId,
  type OrganizationLifecycleLimits,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type RecordTypeLifecyclePolicy,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
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
  | (RecordTypeLifecyclePolicyCommonFields &
      Readonly<{
        action: "delete";
        /** Absent means no recovery window: restore is refused, never unlimited. */
        recoveryWindowDays?: number;
      }>)
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
  readonly organizationId: OrganizationId;
  readonly storageContractId: StorageContractId;
  readonly applicationRootId: ApplicationRootId | null;
  /** Must match the organisation's current lifecycle-limits revision. */
  readonly expectedSettingsRevision: number;
  /** `null` when creating the first policy for this exact target. */
  readonly expectedPolicyRevision: number | null;
  readonly policy: RecordTypeLifecyclePolicyActionInput;
}

/**
 * Initial policy setup for a record type of an Application that is still
 * being provisioned (#567).
 *
 * The #566 administration save requires an already-active installation, and
 * #567 makes activation require a stored policy for every record type the
 * installation owns. This command is the only route out of that circle: it
 * stores revision 1 and nothing else, for one exact storage contract and
 * application scope, bound to one exact provisioned Module binding revision
 * and the organisation's exact current limits revision. An existing policy is
 * refused rather than updated, so it never becomes a second way to change a
 * policy that #566 already governs.
 */
export interface SaveInitialRecordTypeLifecyclePolicyForProvisionedSetupCommand {
  readonly organizationId: OrganizationId;
  /** The Application being installed; always present, never null. */
  readonly bindingApplicationRootId: ApplicationRootId;
  /** Must match the provisioned Module binding revision for this target. */
  readonly expectedBindingRevision: number;
  readonly storageContractId: StorageContractId;
  /** `null` only for an organisation-shared record type. */
  readonly applicationRootId: ApplicationRootId | null;
  /** Must match the organisation's current lifecycle-limits revision. */
  readonly expectedSettingsRevision: number;
  readonly policy: RecordTypeLifecyclePolicyActionInput;
}

export interface ReadProvisionedLifecyclePolicySetupCommand {
  /** Candidate used only by the existing HUMAN scope resolver. */
  readonly organizationId: OrganizationId;
  readonly applicationRootId: ApplicationRootId;
  readonly applicationReleaseRevision: number;
  readonly expectedModuleBindings: readonly Readonly<{
    moduleRootId: ModuleRootId;
    bindingRevision: number;
  }>[];
}

export interface ProvisionedLifecyclePolicySourceBinding {
  readonly moduleRootId: ModuleRootId;
  readonly moduleReleaseRevision: number;
  readonly bindingRevision: number;
}

export type ProvisionedLifecyclePolicyTargetPolicy =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "configured";
      policyId: string;
      policyRevision: number;
      policyBody: RecordTypeLifecyclePolicy;
    }>;

export interface ProvisionedLifecyclePolicySetupTarget {
  readonly storageContractId: StorageContractId;
  readonly storageScope: "application_contained" | "organization_shared";
  readonly applicationRootId: ApplicationRootId | null;
  readonly sourceBindings: readonly ProvisionedLifecyclePolicySourceBinding[];
  readonly policy: ProvisionedLifecyclePolicyTargetPolicy;
}

export interface ProvisionedLifecyclePolicySetupSnapshot {
  readonly organizationId: OrganizationId;
  readonly applicationRootId: ApplicationRootId;
  readonly applicationReleaseRevision: number;
  readonly registrationRevision: number;
  readonly organizationLimits: OrganizationLifecycleLimits;
  readonly targets: readonly ProvisionedLifecyclePolicySetupTarget[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSafeRevision = (value: unknown) => revisionSchema.safeParse(value);

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
    if (!hasOnlyKeys(candidate, [...deletePolicyKeys, "recoveryWindowDays"])) return undefined;
    if (!("recoveryWindowDays" in candidate)) return { action: "delete", ...common };
    const recoveryWindowDays = candidate.recoveryWindowDays;
    if (
      typeof recoveryWindowDays !== "number" ||
      !Number.isSafeInteger(recoveryWindowDays) ||
      recoveryWindowDays < 1 ||
      recoveryWindowDays > maximumRecoveryWindowDays
    )
      return undefined;
    return { action: "delete", ...common, recoveryWindowDays };
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

const provisionedSetupCommandKeys = [
  "organizationId",
  "bindingApplicationRootId",
  "expectedBindingRevision",
  "storageContractId",
  "applicationRootId",
  "expectedSettingsRevision",
  "policy",
] as const;

const parseSaveInitialPolicyForProvisionedSetupCommand = (
  candidate: unknown,
): SaveInitialRecordTypeLifecyclePolicyForProvisionedSetupCommand | undefined => {
  if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, provisionedSetupCommandKeys))
    return undefined;
  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const bindingApplicationRootId = applicationRootIdSchema.safeParse(
    candidate.bindingApplicationRootId,
  );
  const expectedBindingRevision = parseSafeRevision(candidate.expectedBindingRevision);
  const storageContractId = storageContractIdSchema.safeParse(candidate.storageContractId);
  const applicationRootId =
    candidate.applicationRootId === null
      ? { success: true as const, data: null }
      : applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const expectedSettingsRevision = parseSafeRevision(candidate.expectedSettingsRevision);
  const policy = parseRecordTypeLifecyclePolicyActionInput(candidate.policy);

  if (
    !organizationId.success ||
    !bindingApplicationRootId.success ||
    !expectedBindingRevision.success ||
    !storageContractId.success ||
    !applicationRootId.success ||
    !expectedSettingsRevision.success ||
    policy === undefined ||
    // The policy scope is either this exact Application or, for an
    // organisation-shared record type, no Application at all.
    (applicationRootId.data !== null &&
      !sameId(applicationRootId.data, bindingApplicationRootId.data))
  )
    return undefined;

  return {
    organizationId: organizationId.data,
    bindingApplicationRootId: bindingApplicationRootId.data,
    expectedBindingRevision: expectedBindingRevision.data,
    storageContractId: storageContractId.data,
    applicationRootId: applicationRootId.data,
    expectedSettingsRevision: expectedSettingsRevision.data,
    policy,
  };
};

const provisionedSetupReadCommandKeys = [
  "organizationId",
  "applicationRootId",
  "applicationReleaseRevision",
  "expectedModuleBindings",
] as const;

const parseReadProvisionedLifecyclePolicySetupCommand = (
  candidate: unknown,
): ReadProvisionedLifecyclePolicySetupCommand | undefined => {
  if (!isPlainObject(candidate) || !hasOnlyKeys(candidate, provisionedSetupReadCommandKeys))
    return undefined;
  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const applicationReleaseRevision = parseSafeRevision(candidate.applicationReleaseRevision);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !applicationReleaseRevision.success ||
    !Array.isArray(candidate.expectedModuleBindings) ||
    candidate.expectedModuleBindings.length === 0 ||
    candidate.expectedModuleBindings.length > 10_000
  )
    return undefined;

  const expectedModuleBindings: Array<{
    moduleRootId: ModuleRootId;
    bindingRevision: number;
  }> = [];
  let previousModuleRootId: string | undefined;
  for (const value of candidate.expectedModuleBindings) {
    if (!isPlainObject(value) || !hasOnlyKeys(value, ["moduleRootId", "bindingRevision"]))
      return undefined;
    const moduleRootId = moduleRootIdSchema.safeParse(value.moduleRootId);
    const bindingRevision = parseSafeRevision(value.bindingRevision);
    if (
      !moduleRootId.success ||
      !bindingRevision.success ||
      moduleRootId.data !== moduleRootId.data.toLowerCase()
    )
      return undefined;
    const canonicalModuleRootId = moduleRootId.data.toLowerCase();
    if (
      previousModuleRootId !== undefined &&
      previousModuleRootId >= canonicalModuleRootId
    )
      return undefined;
    previousModuleRootId = canonicalModuleRootId;
    expectedModuleBindings.push({
      moduleRootId: moduleRootId.data,
      bindingRevision: bindingRevision.data,
    });
  }

  return {
    organizationId: organizationId.data,
    applicationRootId: applicationRootId.data,
    applicationReleaseRevision: applicationReleaseRevision.data,
    expectedModuleBindings,
  };
};

const compareCanonicalUuidText = (left: string, right: string): number => {
  const canonicalLeft = left.toLowerCase();
  const canonicalRight = right.toLowerCase();
  return canonicalLeft < canonicalRight ? -1 : canonicalLeft > canonicalRight ? 1 : 0;
};

const parseReadProvisionedLifecyclePolicySetupSnapshot = (
  candidate: unknown,
): ProvisionedLifecyclePolicySetupSnapshot | undefined => {
  if (
    !isPlainObject(candidate) ||
    !hasOnlyKeys(candidate, [
      "organizationId",
      "applicationRootId",
      "applicationReleaseRevision",
      "registrationRevision",
      "organizationLimits",
      "targets",
    ])
  )
    return undefined;
  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const applicationReleaseRevision = parseSafeRevision(candidate.applicationReleaseRevision);
  const registrationRevision = parseSafeRevision(candidate.registrationRevision);
  const organizationLimits = organizationLifecycleLimitsSchema.safeParse(
    candidate.organizationLimits,
  );
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !applicationReleaseRevision.success ||
    !registrationRevision.success ||
    !organizationLimits.success ||
    !sameId(organizationLimits.data.organizationId, organizationId.data) ||
    !Array.isArray(candidate.targets) ||
    candidate.targets.length === 0
  )
    return undefined;

  const targets: ProvisionedLifecyclePolicySetupTarget[] = [];
  let previousStorageContractId: string | undefined;
  for (const value of candidate.targets) {
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, [
        "storageContractId",
        "storageScope",
        "applicationRootId",
        "sourceBindings",
        "policy",
      ])
    )
      return undefined;
    const storageContractId = storageContractIdSchema.safeParse(value.storageContractId);
    const applicationRootForTarget =
      value.applicationRootId === null
        ? { success: true as const, data: null }
        : applicationRootIdSchema.safeParse(value.applicationRootId);
    if (
      !storageContractId.success ||
      !applicationRootForTarget.success ||
      (value.storageScope !== "application_contained" &&
        value.storageScope !== "organization_shared") ||
      (value.storageScope === "application_contained" &&
        (applicationRootForTarget.data === null ||
          !sameId(applicationRootForTarget.data, applicationRoot.data))) ||
      (value.storageScope === "organization_shared" && applicationRootForTarget.data !== null) ||
      (previousStorageContractId !== undefined &&
        compareCanonicalUuidText(previousStorageContractId, storageContractId.data) >= 0) ||
      !Array.isArray(value.sourceBindings) ||
      value.sourceBindings.length === 0 ||
      !isPlainObject(value.policy)
    )
      return undefined;
    previousStorageContractId = storageContractId.data;

    const sourceBindings: ProvisionedLifecyclePolicySourceBinding[] = [];
    let previousModuleRootId: string | undefined;
    for (const sourceValue of value.sourceBindings) {
      if (
        !isPlainObject(sourceValue) ||
        !hasOnlyKeys(sourceValue, ["moduleRootId", "moduleReleaseRevision", "bindingRevision"])
      )
        return undefined;
      const moduleRootId = moduleRootIdSchema.safeParse(sourceValue.moduleRootId);
      const moduleReleaseRevision = parseSafeRevision(sourceValue.moduleReleaseRevision);
      const bindingRevision = parseSafeRevision(sourceValue.bindingRevision);
      if (
        !moduleRootId.success ||
        !moduleReleaseRevision.success ||
        !bindingRevision.success ||
        (previousModuleRootId !== undefined &&
          compareCanonicalUuidText(previousModuleRootId, moduleRootId.data) >= 0)
      )
        return undefined;
      previousModuleRootId = moduleRootId.data;
      sourceBindings.push({
        moduleRootId: moduleRootId.data,
        moduleReleaseRevision: moduleReleaseRevision.data,
        bindingRevision: bindingRevision.data,
      });
    }

    let policy: ProvisionedLifecyclePolicyTargetPolicy;
    if (value.policy.state === "absent") {
      if (!hasOnlyKeys(value.policy, ["state"])) return undefined;
      policy = { state: "absent" };
    } else if (value.policy.state === "configured") {
      if (!hasOnlyKeys(value.policy, ["state", "policyId", "policyRevision", "policyBody"]))
        return undefined;
      const policyId = recordLifecyclePolicyIdSchema.safeParse(value.policy.policyId);
      const policyRevision = parseSafeRevision(value.policy.policyRevision);
      const policyBody = recordTypeLifecyclePolicySchema.safeParse(value.policy.policyBody);
      if (
        !policyId.success ||
        !policyRevision.success ||
        !policyBody.success ||
        !sameId(policyBody.data.policyId, policyId.data) ||
        policyBody.data.policyRevision !== policyRevision.data ||
        !sameId(policyBody.data.organizationId, organizationId.data) ||
        !sameId(policyBody.data.storageContractId, storageContractId.data) ||
        (policyBody.data.applicationRootId === null) !==
          (applicationRootForTarget.data === null) ||
        (policyBody.data.applicationRootId !== null &&
          applicationRootForTarget.data !== null &&
          !sameId(policyBody.data.applicationRootId, applicationRootForTarget.data))
      )
        return undefined;
      policy = {
        state: "configured",
        policyId: policyId.data,
        policyRevision: policyRevision.data,
        policyBody: policyBody.data,
      };
    } else {
      return undefined;
    }

    targets.push({
      storageContractId: storageContractId.data,
      storageScope: value.storageScope,
      applicationRootId: applicationRootForTarget.data,
      sourceBindings,
      policy,
    });
  }

  return {
    organizationId: organizationId.data,
    applicationRootId: applicationRoot.data,
    applicationReleaseRevision: applicationReleaseRevision.data,
    registrationRevision: registrationRevision.data,
    organizationLimits: organizationLimits.data,
    targets,
  };
};

const requireOneRow = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("RECORD_LIFECYCLE_POLICY_STORAGE_UNAVAILABLE");
  return rows[0];
};

type LimitsRow = DatabaseRow & { limits: unknown };

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
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
          !sameId(stored.data.organizationId, canonicalLimits.organizationId) ||
          stored.data.settingsRevision !== 1 ||
          stored.data.maxRetentionDays !== canonicalLimits.maxRetentionDays ||
          stored.data.maxRecordCount !== canonicalLimits.maxRecordCount ||
          stored.data.allowUnlimitedRetentionDays !== canonicalLimits.allowUnlimitedRetentionDays ||
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

type ProvisionedSetupReaderRow = DatabaseRow & {
  snapshot: unknown;
};

type ProvisionedSetupCompletionRow = DatabaseRow & {
  request_context: unknown;
  completed_at: unknown;
};

const provisionedSetupReadDeclaration = organizationAccessDeclarationSchema.parse({
  operationKey: "platform.organization.record_lifecycle.manage_policy",
  action: { actionKind: "manage" },
  target: { kind: "organization" },
  requiredPermission: {
    ownerKind: "platform",
    ownerId: "cabe121e-0baf-4084-9471-cce915d460a8",
    permissionId: "7ecd3304-f16c-47d4-94db-0964980091ba",
  },
  recentAuthentication: { kind: "none" },
  authority: { kind: "permission" },
});

const provisionedSetupInstallDeclaration = organizationAccessDeclarationSchema.parse({
  operationKey: "platform.organization.applications.install",
  action: { actionKind: "manage" },
  target: { kind: "organization" },
  requiredPermission: {
    ownerKind: "platform",
    ownerId: "cabe121e-0baf-4084-9471-cce915d460a8",
    permissionId: "7ecd3304-f16c-47d4-94db-0964980091ba",
  },
  recentAuthentication: { kind: "none" },
  authority: { kind: "permission" },
});

const provisionedSetupInstallScopeDeclaration = organizationAccessDeclarationSchema.parse({
  operationKey: "platform.organization.applications.install_scope",
  action: { actionKind: "manage" },
  target: { kind: "organization" },
  requiredPermission: {
    ownerKind: "platform",
    ownerId: "cabe121e-0baf-4084-9471-cce915d460a8",
    permissionId: "7ecd3304-f16c-47d4-94db-0964980091ba",
  },
  recentAuthentication: { kind: "none" },
  authority: {
    kind: "delegated_management",
    before: { kind: "organization_catalogue" },
    after: { kind: "organization_catalogue" },
  },
});

const isCurrentProvisionedSetupDecision = (
  decision: OrganizationAccessDecision,
  operationKey: string,
  scope: SelectedOrganizationScope,
  correlationId: string,
  completedAt: number,
): boolean =>
  decision.outcome === "allowed" &&
  decision.operationKey === operationKey &&
  decision.target.kind === "organization" &&
  sameId(decision.organizationId, scope.organizationId) &&
  sameId(decision.organizationAccountId, scope.organizationAccountId) &&
  decision.accessVersion === scope.accessVersion &&
  sameId(decision.correlationId, correlationId) &&
  Date.parse(decision.checkedAt) <= completedAt &&
  Date.parse(decision.validUntil) > completedAt;

const isCurrentProvisionedSetupRead = (
  snapshot: ProvisionedLifecyclePolicySetupSnapshot,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  managePolicyDecision: OrganizationAccessDecision,
  installDecision: OrganizationAccessDecision,
  installScopeDecision: OrganizationAccessDecision,
  row: ProvisionedSetupCompletionRow | undefined,
): boolean => {
  if (row === undefined) return false;
  const context = sessionContextSchema.safeParse(row.request_context);
  const completedAt = timestampSchema.safeParse(databaseTimestamp(row.completed_at));
  if (!context.success || !completedAt.success) return false;
  const current = context.data;
  const completedMs = Date.parse(completedAt.data);
  return (
    current.callerKind === "human" &&
    sameId(current.tenantId, scope.tenantId) &&
    sameId(current.organizationId, scope.organizationId) &&
    sameId(current.organizationAccountId, scope.organizationAccountId) &&
    current.applicationRootId !== undefined &&
    scope.applicationRootId !== undefined &&
    sameId(current.applicationRootId, scope.applicationRootId) &&
    sameId(current.applicationRootId, snapshot.applicationRootId) &&
    sameId(current.identityId, session.identityId) &&
    sameId(current.sessionId, session.sessionId) &&
    current.authenticationStrength === session.authenticationStrength &&
    current.accessTokenIssuedAt === session.accessTokenIssuedAt &&
    current.primaryAuthenticatedAt === session.primaryAuthenticatedAt &&
    current.multiFactorAuthenticatedAt === session.multiFactorAuthenticatedAt &&
    current.issuedAt === issuedAt &&
    current.expiresAt === session.accessTokenExpiresAt &&
    current.accessVersion === scope.accessVersion &&
    isCurrentProvisionedSetupDecision(
      installDecision,
      provisionedSetupInstallDeclaration.operationKey,
      scope,
      current.correlationId,
      completedMs,
    ) &&
    isCurrentProvisionedSetupDecision(
      installScopeDecision,
      provisionedSetupInstallScopeDeclaration.operationKey,
      scope,
      current.correlationId,
      completedMs,
    ) &&
    isCurrentProvisionedSetupDecision(
      managePolicyDecision,
      provisionedSetupReadDeclaration.operationKey,
      scope,
      current.correlationId,
      completedMs,
    ) &&
    Date.parse(current.issuedAt) <= completedMs &&
    Date.parse(current.expiresAt) > completedMs &&
    sameId(snapshot.organizationId, current.organizationId)
  );
};

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
  (stored.action === "delete"
    ? submitted.action === "delete" && stored.recoveryWindowDays === submitted.recoveryWindowDays
    : submitted.action === "archive_workflow" &&
      sameId(stored.archiveWorkflowId, submitted.archiveWorkflowId) &&
      stored.expectedWorkflowRevision === submitted.expectedWorkflowRevision &&
      sameId(stored.archiveConnectionInstanceId, submitted.archiveConnectionInstanceId) &&
      stored.archiveDestination === submitted.archiveDestination &&
      stored.expectedConnectionRevision === submitted.expectedConnectionRevision &&
      stored.expectedDestinationFingerprint === submitted.expectedDestinationFingerprint &&
      stored.expectedConnectionHealthOutcome === submitted.expectedConnectionHealthOutcome);

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
    readProvisionedSetup: async (
      session: IdentitySession,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ProvisionedLifecyclePolicySetupSnapshot>> => {
      const command = parseReadProvisionedLifecyclePolicySetupCommand(commandCandidate);
      if (command === undefined) return { kind: "unavailable" };
      const selection: OrganizationSelectionCandidate = {
        organizationId: command.organizationId,
        applicationRootId: command.applicationRootId,
      };

      const requestResult = await requests.runChange(
        session,
        selection,
        async (transaction, scope, issuedAt) => {
          if (
            scope.applicationRootId === undefined ||
            !sameId(scope.applicationRootId, command.applicationRootId)
          )
            throw new Error("RECORD_LIFECYCLE_POLICY_SETUP_UNAVAILABLE");

          const rows = await transaction.query<ProvisionedSetupReaderRow>`
            select vortex_record.read_provisioned_lifecycle_policy_setup(
              ${command.applicationRootId}::uuid,
              ${command.applicationReleaseRevision}::bigint,
              ${JSON.stringify(command.expectedModuleBindings)}::text::jsonb
            ) as snapshot
          `;
          const row = requireOneRow(rows);
          const snapshot = parseReadProvisionedLifecyclePolicySetupSnapshot(row.snapshot);
          if (
            snapshot === undefined ||
            !sameId(snapshot.organizationId, scope.organizationId) ||
            !sameId(snapshot.applicationRootId, command.applicationRootId) ||
            snapshot.applicationReleaseRevision !== command.applicationReleaseRevision
          )
            throw new Error("RECORD_LIFECYCLE_POLICY_SETUP_UNAVAILABLE");

          const installResult = await runOrganizationAccessOperation(
            transaction,
            scope,
            provisionedSetupInstallDeclaration,
            async (decision) => decision,
          );
          const installScopeResult = await runOrganizationAccessOperation(
            transaction,
            scope,
            provisionedSetupInstallScopeDeclaration,
            async (decision) => decision,
          );
          const accessResult = await runOrganizationAccessOperation(
            transaction,
            scope,
            provisionedSetupReadDeclaration,
            async (decision) => decision,
          );
          if (
            installResult.outcome !== "completed" ||
            installScopeResult.outcome !== "completed" ||
            accessResult.outcome !== "completed"
          )
            return { kind: "unavailable" } as const;
          const completionRows = await transaction.query<ProvisionedSetupCompletionRow>`
            select vortex_access.validated_human_request_context() as request_context,
              pg_catalog.clock_timestamp() as completed_at
          `;
          if (
            completionRows.length !== 1 ||
            !isCurrentProvisionedSetupRead(
              snapshot,
              scope,
              session,
              issuedAt,
              accessResult.value,
              installResult.value,
              installScopeResult.value,
              completionRows[0],
            )
          )
            throw new Error("RECORD_LIFECYCLE_POLICY_SETUP_UNAVAILABLE");
          return { kind: "snapshot", value: snapshot } as const;
        },
      );

      if (requestResult.kind !== "available") return requestResult;
      return requestResult.value.kind === "snapshot"
        ? { kind: "available", value: requestResult.value.value }
        : { kind: "unavailable" };
    },

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
        // Every vortex_record write entry (apply_lifecycle_record_changes for
        // delete, restore and ownership transfer, save-record, named-action
        // storage) is granted execute only to vortex_runtime; the request-role
        // transaction re-elevates to it immediately before the call, the same
        // as those existing callers.
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
          !sameId(parsed.data.organizationId, scope.organizationId) ||
          !sameId(parsed.data.storageContractId, command.storageContractId) ||
          (parsed.data.applicationRootId === null) !== (command.applicationRootId === null) ||
          (parsed.data.applicationRootId !== null &&
            command.applicationRootId !== null &&
            !sameId(parsed.data.applicationRootId, command.applicationRootId)) ||
          parsed.data.policyRevision !== expectedRevision ||
          !storedPolicyMatchesCommand(parsed.data, command.policy)
        )
          throw new Error("RECORD_LIFECYCLE_POLICY_STORAGE_UNAVAILABLE");
        return parsed.data;
      });
    },

    /**
     * Stores the first lifecycle policy for one record type while its
     * Application installation is still provisioned, so that #567 activation
     * has an executable policy to gate on. It can only ever create revision 1
     * for the exact target; an existing policy is refused by the stored
     * primitive rather than updated.
     */
    saveInitialForProvisionedSetup: async (
      session: IdentitySession,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<RecordTypeLifecyclePolicy>> => {
      const command = parseSaveInitialPolicyForProvisionedSetupCommand(commandCandidate);
      if (command === undefined) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      // Provisioned setup is always an Application-scoped request: the
      // binding that authorises it belongs to exactly one Application, even
      // when the record type it configures is organisation-shared.
      const selection: OrganizationSelectionCandidate = {
        organizationId: command.organizationId,
        applicationRootId: command.bindingApplicationRootId,
      };

      return requests.runChange(session, selection, async (transaction, scope) => {
        await transaction.query`set local role vortex_runtime`;
        const rows = await transaction.query<PolicyRow>`
          select vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(
            ${command.bindingApplicationRootId}::uuid,
            ${command.expectedBindingRevision}::bigint,
            ${command.storageContractId}::uuid,
            ${command.applicationRootId}::uuid,
            ${command.expectedSettingsRevision}::bigint,
            ${activityId}::uuid,
            ${JSON.stringify(command.policy)}::text::jsonb
          ) as policy
        `;
        const row = requireOneRow(rows);
        const parsed = recordTypeLifecyclePolicySchema.safeParse(row.policy);
        if (
          !parsed.success ||
          !sameId(parsed.data.organizationId, scope.organizationId) ||
          !sameId(parsed.data.storageContractId, command.storageContractId) ||
          (parsed.data.applicationRootId === null) !== (command.applicationRootId === null) ||
          (parsed.data.applicationRootId !== null &&
            command.applicationRootId !== null &&
            !sameId(parsed.data.applicationRootId, command.applicationRootId)) ||
          parsed.data.policyRevision !== 1 ||
          !storedPolicyMatchesCommand(parsed.data, command.policy)
        )
          throw new Error("RECORD_LIFECYCLE_POLICY_STORAGE_UNAVAILABLE");
        return parsed.data;
      });
    },
  });
};

/**
 * The pure #567 recovery-eligibility decision. It is re-exported here so the
 * Record lifecycle-policy runtime is the single callable surface for it; the
 * decision itself observes and changes nothing, and owns no restore, totals,
 * due-metadata, Activity, Event or receipt behaviour.
 */
export {
  decideRecordRecoveryEligibility,
  maximumRecoveryWindowDays,
  recordRecoveryEligibilityInputSchema,
  type RecordRecoveryEligibilityDecision,
  type RecordRecoveryEligibilityInput,
  type RecordRecoveryEligibilityReason,
  type RecordRecoveryPolicy,
} from "@vortex/contracts";
