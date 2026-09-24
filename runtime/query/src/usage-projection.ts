import "server-only";

import { z } from "zod";
import {
  identitySessionSchema,
  organizationIdSchema,
  tenantIdSchema,
  type IdentitySession,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";

const periodSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((period, context) => {
    const start = Date.parse(period.start);
    const end = Date.parse(period.end);
    if (end <= start || end - start > 366 * 24 * 60 * 60 * 1000)
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Usage period must be positive and at most 366 days",
      });
    if (start % (24 * 60 * 60 * 1000) !== 0 || end % (24 * 60 * 60 * 1000) !== 0)
      context.addIssue({
        code: "custom",
        path: ["start"],
        message: "Usage period boundaries use UTC day starts",
      });
  });

export const usageProjectionCommandSchema = z
  .object({
    tenantId: tenantIdSchema,
    scope: z.enum(["tenant", "organization"]),
    organizationId: organizationIdSchema.optional(),
    period: periodSchema,
    grouping: z.enum(["day", "week", "month"]),
    pageSize: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === "organization") !== (value.organizationId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["organizationId"],
        message: "Organisation scope requires exactly one organisation",
      });
  });
export type UsageProjectionCommand = z.infer<typeof usageProjectionCommandSchema>;

const usageBucketSchema = z
  .object({
    periodStart: z.string().datetime({ offset: true }),
    capabilityKey: z.string().min(1).max(120),
    unit: z.string().min(1).max(80),
    quantity: z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
    acceptedEventCount: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    organizationId: organizationIdSchema.optional(),
  })
  .strict();

export const usageProjectionResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    scope: z.enum(["tenant", "organization"]),
    buckets: z.array(usageBucketSchema).max(100),
    reconciliation: z.object({
      state: z.enum(["reconciled", "discrepancy"]),
      freshness: z.enum(["current", "stale"]),
      source: z.literal("accepted_events"),
      observedAt: z.string().datetime({ offset: true }),
      discrepancyCount: z.number().int().nonnegative(),
      alerts: z
        .array(
          z
            .object({
              code: z.literal("usage_rollup_mismatch"),
              bucketStart: z.string().datetime({ offset: true }),
            })
            .strict(),
        )
        .max(20),
    }).strict(),
    nextCursor: z.string().optional(),
  }).strict(),
  z.object({ outcome: z.literal("refused"), reasonCode: z.enum(["request_invalid", "unavailable"]) }).strict(),
]);
export type UsageProjectionResult = z.infer<typeof usageProjectionResultSchema>;

type ProjectionRow = DatabaseRow & {
  result: unknown;
};
type UsageProjectionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;
export type UsageProjectionServiceDependencies = Readonly<{
  runtimeTransaction?: UsageProjectionRunner;
}>;

const refusal = (reasonCode: "request_invalid" | "unavailable"): UsageProjectionResult => ({
  outcome: "refused",
  reasonCode,
});
const onlyResult = (rows: readonly ProjectionRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("USAGE_PROJECTION_RESULT_INVALID");
  return rows[0].result;
};

/**
 * Rebuilds and reads permitted usage from accepted metering evidence. The SQL
 * boundary rechecks current tenant-administrator authority; command fields
 * select a bounded view and never assert authority.
 */
export const createUsageProjectionService = (dependencies: UsageProjectionServiceDependencies = {}) => {
  const run = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  return Object.freeze({
    async read(session: IdentitySession, candidate: unknown): Promise<UsageProjectionResult> {
      const identity = identitySessionSchema.safeParse(session);
      const command = usageProjectionCommandSchema.safeParse(candidate);
      if (!identity.success || !command.success) return refusal("request_invalid");
      try {
        const value = command.data;
        const rows = await run((transaction) => transaction.query<ProjectionRow>`
          select vortex_access.read_usage_projection(
            ${identity.data.identityId}::uuid,
            ${value.tenantId}::uuid,
            ${value.scope}::text,
            ${value.organizationId ?? null}::uuid,
            ${value.period.start}::timestamptz,
            ${value.period.end}::timestamptz,
            ${value.grouping}::text,
            ${value.pageSize}::integer,
            ${value.cursor ?? null}::text
          ) as result
        `);
        return usageProjectionResultSchema.parse(onlyResult(rows));
      } catch {
        return refusal("unavailable");
      }
    },
  });
};
