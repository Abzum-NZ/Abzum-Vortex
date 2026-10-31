import "server-only";

import { sameId } from "../catalogue/runtime-primitives";
import {
  initialRecordLifecyclePolicySchema,
  organizationLifecycleLimitsSchema,
  type OrganizationLifecycleLimits,
} from "./record-lifecycle-policy";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeTransactionRunner,
} from "../db/request-transaction";

const requireOneRow = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("RECORD_LIFECYCLE_POLICY_STORAGE_UNAVAILABLE");
  return rows[0];
};

type LimitsRow = DatabaseRow & { limits: unknown };

interface RecordLifecycleLimitsStoreDependencies {
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
    async initialize(
      limitsCandidate: unknown,
      initialPolicyCandidate: unknown,
    ): Promise<OrganizationLifecycleLimits> {
      const initialPolicy = initialRecordLifecyclePolicySchema.parse(initialPolicyCandidate);
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
            ${JSON.stringify({ ...canonicalLimits, initialPolicy })}::text::jsonb
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
          // archive leftover: removed by FIX-DB-SECURITY
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
