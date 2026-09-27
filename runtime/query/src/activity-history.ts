import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  activityActorKindSchema,
  activityAggregateDimensionSchema,
  activityHistoryFilterSchema,
  activityIdSchema,
  activityOutcomeSchema,
  activityProjectionSchema,
  activitySourceSchema,
  actorIdSchema,
  builderKeySchema,
  correlationIdSchema,
  fieldIdSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  timestampSchema,
  type IdentityId,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  fingerprintQueryInputs,
  QueryContinuationTokenError,
  type QueryContinuationKey,
} from "./continuation-token";

/** One redacted Activity projection entry; business payloads and values never appear. */
export const activityHistoryEntrySchema = z
  .object({
    activityId: activityIdSchema,
    occurredAt: timestampSchema,
    actorKind: activityActorKindSchema,
    actorId: actorIdSchema,
    action: builderKeySchema,
    subjectIds: z.array(platformIdSchema).min(1),
    /** Present only in the authorised organisation-audit projection. */
    changedFieldIds: z.array(fieldIdSchema).optional(),
    source: activitySourceSchema,
    correlationId: correlationIdSchema,
    outcome: activityOutcomeSchema,
  })
  .strict();
export type ActivityHistoryEntry = z.infer<typeof activityHistoryEntrySchema>;

export const activityHistoryPageCommandSchema = z
  .object({
    kind: z.literal("page"),
    filter: activityHistoryFilterSchema,
    pageSize: z.number().int().min(1).max(200),
    continuationToken: z.string().min(1).max(65_536).optional(),
  })
  .strict();

export const activityHistoryAggregateCommandSchema = z
  .object({
    kind: z.literal("aggregate"),
    filter: activityHistoryFilterSchema,
    groupBy: activityAggregateDimensionSchema,
  })
  .strict();

export const activityHistoryCommandSchema = z.discriminatedUnion("kind", [
  activityHistoryPageCommandSchema,
  activityHistoryAggregateCommandSchema,
]);
export type ActivityHistoryCommand = z.infer<typeof activityHistoryCommandSchema>;

export const activityHistoryRefusalReasonCodes = [
  "request_invalid",
  "cursor_invalid",
  "cursor_stale",
] as const;
export type ActivityHistoryRefusalReasonCode = (typeof activityHistoryRefusalReasonCodes)[number];

/** Every refusal is this one neutral shape, decided before any entry is exposed. */
export const activityHistoryRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(activityHistoryRefusalReasonCodes),
  })
  .strict();
export type ActivityHistoryRefusal = z.infer<typeof activityHistoryRefusalSchema>;

const activityNextCursorSchema = z
  .object({ occurredAt: timestampSchema, activityId: activityIdSchema })
  .strict();

export const activityAggregateGroupSchema = z
  .object({
    value: z.string().min(1).max(120),
    count: z.number().int().min(0),
  })
  .strict();
export type ActivityAggregateGroup = z.infer<typeof activityAggregateGroupSchema>;

export const activityHistoryPageSchema = z
  .object({
    outcome: z.literal("completed"),
    kind: z.literal("page"),
    projection: activityProjectionSchema,
    entries: z.array(activityHistoryEntrySchema).max(200),
    /** Opaque; present only when a later page may hold further permitted entries. */
    nextContinuationToken: z.string().optional(),
  })
  .strict();
export type ActivityHistoryPage = z.infer<typeof activityHistoryPageSchema>;

export const activityHistoryAggregateSchema = z
  .object({
    outcome: z.literal("completed"),
    kind: z.literal("aggregate"),
    projection: activityProjectionSchema,
    groupBy: activityAggregateDimensionSchema,
    total: z.number().int().min(0),
    groups: z.array(activityAggregateGroupSchema).max(100),
    /** True when more than the bounded group count matched and only the largest are shown. */
    truncated: z.boolean(),
  })
  .strict();
export type ActivityHistoryAggregate = z.infer<typeof activityHistoryAggregateSchema>;

export const activityHistoryResultSchema = z.union([
  activityHistoryPageSchema,
  activityHistoryAggregateSchema,
  activityHistoryRefusalSchema,
]);
export type ActivityHistoryResult = z.infer<typeof activityHistoryResultSchema>;

export type ActivityHistoryServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** Server-held AES-256-GCM key that makes continuation tokens opaque and bound. */
    continuationKey: QueryContinuationKey;
  }>;

type ResultRow = DatabaseRow & { readonly result: unknown };

const refusal = (reasonCode: ActivityHistoryRefusalReasonCode): ActivityHistoryRefusal => ({
  outcome: "refused",
  reasonCode,
});

const one = (rows: readonly ResultRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("ACTIVITY_HISTORY_RESULT_INVALID");
  return rows[0].result;
};

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const pageReadSchema = z
  .object({
    outcome: z.literal("completed"),
    projection: activityProjectionSchema,
    entries: z.array(activityHistoryEntrySchema).max(200),
    next: activityNextCursorSchema.nullable(),
  })
  .strict();

const aggregateReadSchema = z
  .object({
    outcome: z.literal("completed"),
    projection: activityProjectionSchema,
    total: z.number().int().min(0),
    groups: z.array(activityAggregateGroupSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();

/**
 * What an Activity continuation carries: the exact actor and filter it was
 * issued for, plus the last keyset position reached. The whole payload is
 * encrypted as well as authenticated so the token is opaque, not merely
 * tamper-evident.
 */
const activityContinuationSchema = z
  .object({
    version: z.literal(1),
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    identityId: identityIdSchema,
    filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    occurredAt: timestampSchema,
    activityId: activityIdSchema,
  })
  .strict();
type ActivityContinuation = z.infer<typeof activityContinuationSchema>;

const tokenVersion = 1;
const nonceLength = 12;
const tagLength = 16;
const associatedData = Buffer.from("vortex.query.activity.continuation.v1", "utf8");

const cipherKey = (key: QueryContinuationKey): Buffer => {
  if (!(key.key instanceof Uint8Array) || key.key.byteLength !== 32)
    throw new Error("ACTIVITY_CONTINUATION_KEY_INVALID");
  return Buffer.from(key.key);
};

const encodeActivityContinuationToken = (
  continuation: ActivityContinuation,
  key: QueryContinuationKey,
): string => {
  const payload = Buffer.from(
    JSON.stringify(activityContinuationSchema.parse(continuation)),
    "utf8",
  );
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(key), nonce, {
    authTagLength: tagLength,
  });
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([
    Buffer.from([tokenVersion]),
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64url");
};

const decodeActivityContinuationToken = (
  token: string,
  key: QueryContinuationKey,
): ActivityContinuation => {
  const secret = cipherKey(key);
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new QueryContinuationTokenError();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length <= 1 + nonceLength + tagLength || bytes[0] !== tokenVersion)
      throw new QueryContinuationTokenError();
    const nonce = bytes.subarray(1, 1 + nonceLength);
    const tag = bytes.subarray(1 + nonceLength, 1 + nonceLength + tagLength);
    const encrypted = bytes.subarray(1 + nonceLength + tagLength);
    const decipher = createDecipheriv("aes-256-gcm", secret, nonce, { authTagLength: tagLength });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    const payload = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const parsed = activityContinuationSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) throw new QueryContinuationTokenError();
    return parsed.data;
  } catch {
    throw new QueryContinuationTokenError();
  }
};

const runPage = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  identityId: IdentityId,
  command: z.infer<typeof activityHistoryPageCommandSchema>,
  continuationKey: QueryContinuationKey,
): Promise<ActivityHistoryResult> => {
  const filter = command.filter;
  let after: ActivityContinuation | undefined;
  if (command.continuationToken !== undefined) {
    try {
      after = decodeActivityContinuationToken(command.continuationToken, continuationKey);
    } catch (error) {
      if (error instanceof QueryContinuationTokenError) return refusal("cursor_invalid");
      throw error;
    }
    if (
      !sameId(after.organizationId, scope.organizationId) ||
      !sameId(after.organizationAccountId, scope.organizationAccountId) ||
      !sameId(after.identityId, identityId)
    )
      return refusal("cursor_stale");
  }

  const filters: Readonly<Record<string, unknown>> = { ...filter };
  const filterFingerprint = fingerprintQueryInputs(filters);
  if (after !== undefined && after.filterFingerprint !== filterFingerprint)
    return refusal("cursor_stale");

  const rows = await transaction.query<ResultRow>`
    select vortex_activity.read_organization_activity_page(
      ${filter.occurredFrom ?? null}::timestamptz,
      ${filter.occurredTo ?? null}::timestamptz,
      ${filter.actorKind ?? null}::text,
      ${filter.actorId ?? null}::uuid,
      ${filter.action ?? null}::text,
      ${filter.correlationId ?? null}::uuid,
      ${filter.outcome ?? null}::text,
      ${filter.source ?? null}::text,
      ${command.pageSize}::integer,
      ${after?.occurredAt ?? null}::timestamptz,
      ${after?.activityId ?? null}::uuid
    ) as result
  `;
  const page = pageReadSchema.parse(one(rows));

  return {
    outcome: "completed",
    kind: "page",
    projection: page.projection,
    entries: page.entries,
    ...(page.next === null
      ? {}
      : {
          nextContinuationToken: encodeActivityContinuationToken(
            {
              version: 1,
              organizationId: scope.organizationId,
              organizationAccountId: scope.organizationAccountId,
              identityId,
              filterFingerprint,
              occurredAt: page.next.occurredAt,
              activityId: page.next.activityId,
            },
            continuationKey,
          ),
        }),
  };
};

const runAggregate = async (
  transaction: RequestDatabaseTransaction,
  command: z.infer<typeof activityHistoryAggregateCommandSchema>,
): Promise<ActivityHistoryResult> => {
  const filter = command.filter;
  const rows = await transaction.query<ResultRow>`
    select vortex_activity.read_organization_activity_aggregates(
      ${filter.occurredFrom ?? null}::timestamptz,
      ${filter.occurredTo ?? null}::timestamptz,
      ${filter.actorKind ?? null}::text,
      ${filter.actorId ?? null}::uuid,
      ${filter.action ?? null}::text,
      ${filter.correlationId ?? null}::uuid,
      ${filter.outcome ?? null}::text,
      ${filter.source ?? null}::text,
      ${command.groupBy}::text
    ) as result
  `;
  const aggregate = aggregateReadSchema.parse(one(rows));

  return {
    outcome: "completed",
    kind: "aggregate",
    projection: aggregate.projection,
    groupBy: command.groupBy,
    total: aggregate.total,
    groups: aggregate.groups,
    truncated: aggregate.truncated,
  };
};

/**
 * Protected Activity history for the verified request. The organisation,
 * identity and organisation account come from the request context alone: a
 * caller always reads the activity they performed and receives the
 * organisation-wide audit projection only when the database confirms the
 * organisation's access-administration read authority. Both projections return
 * only identifiers and outcomes, one bounded page or one bounded group count at
 * a time, or one neutral refusal before any entry is exposed.
 */
export const createActivityHistoryService = (dependencies: ActivityHistoryServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const { continuationKey } = dependencies;

  return Object.freeze({
    async run(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ActivityHistoryResult>> {
      const command = activityHistoryCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      return requests.run(session, selection, (transaction, scope) =>
        command.data.kind === "page"
          ? runPage(transaction, scope, session.identityId, command.data, continuationKey)
          : runAggregate(transaction, command.data),
      );
    },
  });
};
