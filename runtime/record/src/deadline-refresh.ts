import "server-only";

import {
  recordTypeDefinitionV2Schema,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  deriveEarliestPendingDeadlineTransitionV2,
  type PendingDeadlineTransitionV2,
} from "./deadline-transitions";

export type DeadlineRefreshRootMetadata = Readonly<{
  organizationId: string;
  storageContractId: string;
  storageScope: "organization_shared" | "application_contained";
  recordId: string;
  recordTypeId: string;
  applicationRootId?: string;
  concurrencyNumber: number;
}>;

export type DeadlineRefreshAttributionMetadata = Readonly<{
  bindingId: string;
  actorId: string;
  generation: number;
  operation: "refresh_record_deadline";
  systemActorId: string;
}>;

export type DeadlineRefreshEffectMetadata = Readonly<{
  effectId: string;
  effectIdentity: string;
  calculationFieldId: string;
  transitionAt: string;
  recalculatedDeadline?: PendingDeadlineTransitionV2;
}>;

export type ClaimRecordDeadlineRefreshInput = Readonly<{
  organizationId?: string;
  recordId?: string;
  applicationRootId?: string;
  dueBefore?: string;
}>;

export type ClaimRecordDeadlineRefreshResult =
  | Readonly<{
      outcome: "claimed";
      root: DeadlineRefreshRootMetadata;
      attribution: DeadlineRefreshAttributionMetadata;
      effect: DeadlineRefreshEffectMetadata;
      recalculatedDeadline?: PendingDeadlineTransitionV2;
      effectId: string;
      effectIdentity: string;
    }>
  | Readonly<{
      outcome: "none";
    }>
  | Readonly<{
      outcome: "conflict";
      reasonCode: string;
    }>
  | Readonly<{
      outcome: "refused";
      reasonCode: string;
      state?: string;
    }>;

type ClaimRow = DatabaseRow & { readonly result: unknown };

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error("DEADLINE_REFRESH_CLAIM_RESULT_INVALID");
  }
  return rows[0];
};

/**
 * Claims one due organisation/record deadline row, verifies the configured
 * live deadline actor for the exact organisation/application scope, rechecks
 * record and definition concurrency, recalculates the earliest transition
 * through the current Record contract, and returns stable root/effect/attribution
 * metadata for retry-safe orchestration.
 */
export const claimRecordDeadlineRefresh = async (
  transaction: RequestDatabaseTransaction,
  input: ClaimRecordDeadlineRefreshInput = {},
): Promise<ClaimRecordDeadlineRefreshResult> => {
  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<ClaimRow>`
    select vortex_record.claim_record_deadline_refresh(
      ${input.organizationId ?? null}::uuid,
      ${input.recordId ?? null}::uuid,
      ${input.applicationRootId ?? null}::uuid,
      ${input.dueBefore ?? null}::timestamptz,
      null::jsonb
    ) as result
  `;
  const candidate = one(rows).result;
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("DEADLINE_REFRESH_CLAIM_RESULT_INVALID");
  }
  const payload = candidate as Record<string, unknown>;
  if (payload.outcome === "none") {
    return { outcome: "none" };
  }
  if (payload.outcome === "refused") {
    return {
      outcome: "refused",
      reasonCode: String(payload.reasonCode ?? "operation_refused"),
      ...(payload.state !== undefined ? { state: String(payload.state) } : {}),
    };
  }
  if (payload.outcome === "conflict") {
    return {
      outcome: "conflict",
      reasonCode: String(payload.reasonCode ?? "conflict"),
    };
  }
  if (payload.outcome !== "claimed") {
    throw new Error("DEADLINE_REFRESH_CLAIM_RESULT_INVALID");
  }

  const recordTypeParsed = recordTypeDefinitionV2Schema.safeParse(payload.recordType);
  if (!recordTypeParsed.success) {
    throw new Error("DEADLINE_REFRESH_RECORD_TYPE_INVALID");
  }

  const existingValues = (payload.existingValues ?? {}) as Readonly<Record<string, unknown>>;
  const timeZone = typeof payload.timeZone === "string" ? payload.timeZone : "UTC";

  // Recalculate earliest transition through current Record contract
  const recalculatedDeadline = deriveEarliestPendingDeadlineTransitionV2({
    recordType: recordTypeParsed.data,
    finalAuthoritativeFieldValues: existingValues,
    organizationTimeZone: timeZone,
  });

  const root = payload.root as Record<string, unknown>;
  const attribution = payload.attribution as Record<string, unknown>;
  const effect = payload.effect as Record<string, unknown>;

  // Consume and update the due metadata with the newly recalculated transition
  await transaction.query`
    select vortex_record.claim_record_deadline_refresh(
      ${root.organizationId as string}::uuid,
      ${root.recordId as string}::uuid,
      ${(root.applicationRootId as string | undefined) ?? null}::uuid,
      null::timestamptz,
      ${recalculatedDeadline === undefined ? "null" : JSON.stringify(recalculatedDeadline)}::text::jsonb
    ) as result
  `;

  const rootMetadata: DeadlineRefreshRootMetadata = {
    organizationId: String(root.organizationId),
    storageContractId: String(root.storageContractId),
    storageScope: root.storageScope as "organization_shared" | "application_contained",
    recordId: String(root.recordId),
    recordTypeId: String(root.recordTypeId),
    ...(root.applicationRootId ? { applicationRootId: String(root.applicationRootId) } : {}),
    concurrencyNumber: Number(root.concurrencyNumber),
  };

  const attributionMetadata: DeadlineRefreshAttributionMetadata = {
    bindingId: String(attribution.bindingId),
    actorId: String(attribution.actorId),
    generation: Number(attribution.generation),
    operation: "refresh_record_deadline",
    systemActorId: String(attribution.systemActorId ?? attribution.actorId),
  };

  const effectMetadata: DeadlineRefreshEffectMetadata = {
    effectId: String(effect.effectId),
    effectIdentity: String(effect.effectIdentity),
    calculationFieldId: String(effect.calculationFieldId),
    transitionAt: String(effect.transitionAt),
    ...(recalculatedDeadline ? { recalculatedDeadline } : {}),
  };

  return {
    outcome: "claimed",
    root: rootMetadata,
    attribution: attributionMetadata,
    effect: effectMetadata,
    recalculatedDeadline,
    effectId: effectMetadata.effectId,
    effectIdentity: effectMetadata.effectIdentity,
  };
};

export type RecordDeadlineRefreshServiceDependencies = Readonly<{
  activityId?: () => string;
  occurrenceId?: () => string;
}>;

export const createRecordDeadlineRefreshService = (
  _dependencies: RecordDeadlineRefreshServiceDependencies = {},
) =>
  Object.freeze({
    async claim(
      transaction: RequestDatabaseTransaction,
      input: ClaimRecordDeadlineRefreshInput = {},
    ): Promise<ClaimRecordDeadlineRefreshResult> {
      return claimRecordDeadlineRefresh(transaction, input);
    },
    async refresh(
      transaction: RequestDatabaseTransaction,
      input: ClaimRecordDeadlineRefreshInput = {},
    ): Promise<ClaimRecordDeadlineRefreshResult> {
      return claimRecordDeadlineRefresh(transaction, input);
    },
  });
