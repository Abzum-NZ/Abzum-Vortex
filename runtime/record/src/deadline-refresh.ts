import "server-only";

import {
  actorIdSchema,
  applicationRootIdSchema,
  fieldIdSchema,
  jsonValueSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeDefinitionV2Schema,
  recordTypeIdSchema,
  storageContractIdSchema,
  timestampSchema,
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

export const deadlineRefreshConflictReasonCodes = [
  "context_already_established",
  "record_busy",
  "record_unavailable",
  "concurrency_mismatch",
] as const;
export type DeadlineRefreshConflictReasonCode =
  (typeof deadlineRefreshConflictReasonCodes)[number];

export const deadlineRefreshRefusalReasonCodes = [
  "command_invalid",
  "actor_configuration_missing",
  "actor_configuration_disabled",
  "actor_configuration_revoked",
  "actor_configuration_mismatched",
  "actor_session_unauthorized",
  "scope_configuration_unavailable",
  "storage_contract_unavailable",
  "record_storage_incompatible",
] as const;
export type DeadlineRefreshRefusalReasonCode =
  (typeof deadlineRefreshRefusalReasonCodes)[number];

export type ClaimRecordDeadlineRefreshResult =
  | Readonly<{
      outcome: "claimed";
      root: DeadlineRefreshRootMetadata;
      attribution: DeadlineRefreshAttributionMetadata;
      effect: DeadlineRefreshEffectMetadata;
      recalculatedDeadline?: PendingDeadlineTransitionV2;
      effectId: string;
      effectIdentity: string;
      /** Organisation time zone the #558 closure evaluates date deadlines in. */
      timeZone: string;
    }>
  | Readonly<{ outcome: "none" }>
  | Readonly<{ outcome: "conflict"; reasonCode: DeadlineRefreshConflictReasonCode }>
  | Readonly<{
      outcome: "refused";
      reasonCode: DeadlineRefreshRefusalReasonCode;
      state?: "disabled" | "revoked";
    }>;

type ClaimRow = DatabaseRow & { readonly result: unknown };

const one = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("DEADLINE_REFRESH_CLAIM_RESULT_INVALID");
  return rows[0];
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const safeRevision = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const isConflictReasonCode = (candidate: unknown): candidate is DeadlineRefreshConflictReasonCode =>
  typeof candidate === "string" &&
  deadlineRefreshConflictReasonCodes.some((value) => value === candidate);

const isRefusalReasonCode = (candidate: unknown): candidate is DeadlineRefreshRefusalReasonCode =>
  typeof candidate === "string" &&
  deadlineRefreshRefusalReasonCodes.some((value) => value === candidate);

const parseInput = (candidate: unknown): ClaimRecordDeadlineRefreshInput | undefined => {
  if (!isObject(candidate)) return undefined;
  if (
    !hasExactKeys(
      candidate,
      [],
      ["organizationId", "recordId", "applicationRootId", "dueBefore"],
    )
  )
    return undefined;
  const organizationId =
    candidate.organizationId === undefined
      ? undefined
      : organizationIdSchema.safeParse(candidate.organizationId);
  const recordId =
    candidate.recordId === undefined ? undefined : recordIdSchema.safeParse(candidate.recordId);
  const applicationRootId =
    candidate.applicationRootId === undefined
      ? undefined
      : applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const dueBefore =
    candidate.dueBefore === undefined
      ? undefined
      : timestampSchema.safeParse(candidate.dueBefore);
  if (
    organizationId?.success === false ||
    recordId?.success === false ||
    applicationRootId?.success === false ||
    dueBefore?.success === false ||
    ((recordId !== undefined || applicationRootId !== undefined) && organizationId === undefined)
  )
    return undefined;
  return {
    ...(organizationId?.success ? { organizationId: organizationId.data } : {}),
    ...(recordId?.success ? { recordId: recordId.data } : {}),
    ...(applicationRootId?.success ? { applicationRootId: applicationRootId.data } : {}),
    ...(dueBefore?.success ? { dueBefore: dueBefore.data } : {}),
  };
};

const parseRoot = (candidate: unknown): DeadlineRefreshRootMetadata | undefined => {
  if (!isObject(candidate)) return undefined;
  if (
    !hasExactKeys(
      candidate,
      [
        "organizationId",
        "storageContractId",
        "storageScope",
        "recordId",
        "recordTypeId",
        "concurrencyNumber",
      ],
      ["applicationRootId"],
    )
  )
    return undefined;
  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const storageContractId = storageContractIdSchema.safeParse(candidate.storageContractId);
  const recordId = recordIdSchema.safeParse(candidate.recordId);
  const recordTypeId = recordTypeIdSchema.safeParse(candidate.recordTypeId);
  const applicationRootId =
    candidate.applicationRootId === undefined
      ? undefined
      : applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const concurrencyNumber = safeRevision(candidate.concurrencyNumber);
  if (
    !organizationId.success ||
    !storageContractId.success ||
    !recordId.success ||
    !recordTypeId.success ||
    applicationRootId?.success === false ||
    concurrencyNumber === undefined ||
    (candidate.storageScope !== "organization_shared" &&
      candidate.storageScope !== "application_contained") ||
    (candidate.storageScope === "organization_shared" && applicationRootId !== undefined) ||
    (candidate.storageScope === "application_contained" && applicationRootId === undefined)
  )
    return undefined;
  return {
    organizationId: organizationId.data,
    storageContractId: storageContractId.data,
    storageScope: candidate.storageScope,
    recordId: recordId.data,
    recordTypeId: recordTypeId.data,
    ...(applicationRootId?.success ? { applicationRootId: applicationRootId.data } : {}),
    concurrencyNumber,
  };
};

const parseAttribution = (candidate: unknown): DeadlineRefreshAttributionMetadata | undefined => {
  if (
    !isObject(candidate) ||
    !hasExactKeys(candidate, ["bindingId", "actorId", "generation", "operation", "systemActorId"])
  )
    return undefined;
  const bindingId = platformIdSchema.safeParse(candidate.bindingId);
  const actorId = actorIdSchema.safeParse(candidate.actorId);
  const systemActorId = actorIdSchema.safeParse(candidate.systemActorId);
  const generation = safeRevision(candidate.generation);
  if (
    !bindingId.success ||
    !actorId.success ||
    !systemActorId.success ||
    generation === undefined ||
    candidate.operation !== "refresh_record_deadline" ||
    actorId.data !== systemActorId.data
  )
    return undefined;
  return {
    bindingId: bindingId.data,
    actorId: actorId.data,
    generation,
    operation: "refresh_record_deadline",
    systemActorId: systemActorId.data,
  };
};

const parseEffect = (candidate: unknown): DeadlineRefreshEffectMetadata | undefined => {
  if (
    !isObject(candidate) ||
    !hasExactKeys(candidate, [
      "effectId",
      "effectIdentity",
      "calculationFieldId",
      "transitionAt",
    ])
  )
    return undefined;
  const effectId = platformIdSchema.safeParse(candidate.effectId);
  const calculationFieldId = fieldIdSchema.safeParse(candidate.calculationFieldId);
  const transitionAt = timestampSchema.safeParse(candidate.transitionAt);
  if (
    !effectId.success ||
    !calculationFieldId.success ||
    !transitionAt.success ||
    typeof candidate.effectIdentity !== "string" ||
    candidate.effectIdentity.length < 1 ||
    candidate.effectIdentity.length > 500
  )
    return undefined;
  return {
    effectId: effectId.data,
    effectIdentity: candidate.effectIdentity,
    calculationFieldId: calculationFieldId.data,
    transitionAt: transitionAt.data,
  };
};

const validTimeZone = (candidate: unknown): candidate is string => {
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 100)
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
    return true;
  } catch {
    return false;
  }
};

/**
 * Claims one due organisation/record row in the caller's existing transaction.
 * SQL binds the configured session role and establishes the immutable System
 * context before this caller derives the next transition from locked facts.
 */
export const claimRecordDeadlineRefresh = async (
  transaction: RequestDatabaseTransaction,
  inputCandidate: unknown = {},
): Promise<ClaimRecordDeadlineRefreshResult> => {
  const input = parseInput(inputCandidate);
  if (input === undefined) return { outcome: "refused", reasonCode: "command_invalid" };

  await transaction.query`set local role vortex_runtime`;
  const rows = await transaction.query<ClaimRow>`
    select vortex_record.claim_record_deadline_refresh(
      ${input.organizationId ?? null}::uuid,
      ${input.recordId ?? null}::uuid,
      ${input.applicationRootId ?? null}::uuid,
      ${input.dueBefore ?? null}::timestamptz
    ) as result
  `;
  const candidate = one(rows).result;
  if (!isObject(candidate)) throw new Error("DEADLINE_REFRESH_CLAIM_RESULT_INVALID");
  if (candidate.outcome === "none" && hasExactKeys(candidate, ["outcome"]))
    return { outcome: "none" };
  if (
    candidate.outcome === "refused" &&
    hasExactKeys(candidate, ["outcome", "reasonCode"], ["state"]) &&
    isRefusalReasonCode(candidate.reasonCode) &&
    (candidate.state === undefined ||
      candidate.state === "disabled" ||
      candidate.state === "revoked")
  )
    return {
      outcome: "refused",
      reasonCode: candidate.reasonCode,
      ...(candidate.state === undefined ? {} : { state: candidate.state }),
    };
  if (
    candidate.outcome === "conflict" &&
    hasExactKeys(candidate, ["outcome", "reasonCode"]) &&
    isConflictReasonCode(candidate.reasonCode)
  )
    return { outcome: "conflict", reasonCode: candidate.reasonCode };
  if (
    candidate.outcome !== "claimed" ||
    !hasExactKeys(candidate, [
      "outcome",
      "root",
      "attribution",
      "effect",
      "recordType",
      "existingValues",
      "timeZone",
    ])
  )
    throw new Error("DEADLINE_REFRESH_CLAIM_RESULT_INVALID");

  const root = parseRoot(candidate.root);
  const attribution = parseAttribution(candidate.attribution);
  const effect = parseEffect(candidate.effect);
  const recordType = recordTypeDefinitionV2Schema.safeParse(candidate.recordType);
  const existingValues = jsonValueSchema.safeParse(candidate.existingValues);
  const expectedEffectIdentity =
    root === undefined || effect === undefined
      ? undefined
      : `deadline:${root.organizationId}:${root.storageContractId}:${root.applicationRootId ?? "organization_shared"}:${root.recordId}:${root.concurrencyNumber}:${effect.calculationFieldId}:${effect.transitionAt}`;
  if (
    root === undefined ||
    attribution === undefined ||
    effect === undefined ||
    !recordType.success ||
    !existingValues.success ||
    !isObject(existingValues.data) ||
    !validTimeZone(candidate.timeZone) ||
    recordType.data.recordTypeId !== root.recordTypeId ||
    recordType.data.storageContractId !== root.storageContractId ||
    effect.effectIdentity !== expectedEffectIdentity
  )
    throw new Error("DEADLINE_REFRESH_CLAIM_RESULT_INVALID");

  const recalculatedDeadline = deriveEarliestPendingDeadlineTransitionV2({
    recordType: recordType.data,
    finalAuthoritativeFieldValues: existingValues.data,
    organizationTimeZone: candidate.timeZone,
  });
  const effectWithDeadline: DeadlineRefreshEffectMetadata = {
    ...effect,
    ...(recalculatedDeadline === undefined ? {} : { recalculatedDeadline }),
  };
  return {
    outcome: "claimed",
    root,
    attribution,
    effect: effectWithDeadline,
    ...(recalculatedDeadline === undefined ? {} : { recalculatedDeadline }),
    effectId: effect.effectId,
    effectIdentity: effect.effectIdentity,
    timeZone: candidate.timeZone as string,
  };
};

export const createRecordDeadlineRefreshService = () =>
  Object.freeze({
    async claim(
      transaction: RequestDatabaseTransaction,
      inputCandidate: unknown = {},
    ): Promise<ClaimRecordDeadlineRefreshResult> {
      return claimRecordDeadlineRefresh(transaction, inputCandidate);
    },
  });
