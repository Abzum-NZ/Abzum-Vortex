import "server-only";

import {
  alertDeduplicationKeySchema,
  alertRecordSchema,
  alertSeveritySchema,
  builderKeySchema,
  namespacedKeySchema,
  runbookReferenceSchema,
  telemetryServiceSchema,
  timestampSchema,
  type AlertRecord,
  type ServiceTelemetryPort,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";
import { z } from "zod";

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface OperationsAlertSinkDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

/**
 * The canonical shape of one persisted Operations alert signal. It mirrors the
 * protected `vortex_operations.alert_signals` row, with deduplication state
 * owned by the database writer rather than by the producer.
 */
export const operationsAlertSignalSchema = z
  .object({
    signalId: z.uuid(),
    code: namespacedKeySchema,
    severity: alertSeveritySchema,
    affectedService: telemetryServiceSchema,
    deduplicationKey: alertDeduplicationKeySchema,
    owningRole: builderKeySchema,
    runbookReference: runbookReferenceSchema,
    occurrenceCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    firstSeenAt: timestampSchema,
    lastSeenAt: timestampSchema,
    state: z.enum(["open", "resolved"]),
  })
  .strict();

export type OperationsAlertSignal = z.infer<typeof operationsAlertSignalSchema>;

const persistAlertSignal = async (
  runtimeTransaction: RuntimeTransactionRunner,
  record: AlertRecord,
): Promise<void> => {
  await runtimeTransaction(async (transaction) => {
    await transaction.query`
      select vortex_operations.record_alert_signal(
        ${record.code}::text,
        ${record.severity}::text,
        ${record.affectedService}::text,
        ${record.deduplicationKey}::text,
        ${record.owningRole}::text,
        ${record.runbookReference}::text
      )
    `;
  });
};

/**
 * The App-owned downstream that persists alert signals for Operations. It
 * implements the shared `ServiceTelemetryPort` so the existing collector can
 * forward validated alerts, but it deliberately persists alerts only: the
 * signal feed is the bounded, content-free evidence Operations acts on.
 *
 * Collection is a side channel. The collector already contains a synchronous
 * downstream throw, and persistence here is fire-and-forget with its own
 * containment, so a database failure can never change the measured operation's
 * outcome. `appendAlert` is synchronous by contract and schedules the write
 * without awaiting it.
 */
export const createOperationsAlertSink = (
  dependencies: OperationsAlertSinkDependencies = {},
): ServiceTelemetryPort => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;

  return Object.freeze({
    appendTelemetry(): void {
      // Only alert signals are persisted by this sink; measures belong to a
      // separate telemetry consumer that is not in this scope.
    },
    appendAlert(record: AlertRecord): void {
      const parsed = alertRecordSchema.safeParse(record);
      if (!parsed.success) return;
      void persistAlertSignal(runtimeTransaction, parsed.data).catch(() => undefined);
    },
  });
};

type AlertSignalRow = DatabaseRow & {
  signal_id: unknown;
  code: unknown;
  severity: unknown;
  affected_service: unknown;
  deduplication_key: unknown;
  owning_role: unknown;
  runbook_reference: unknown;
  occurrence_count: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  state: unknown;
};

const safeInteger = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return value;
};

const isoInstant = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  return value;
};

/**
 * The narrow Operations read: one bounded page of open signals, most recently
 * seen first. Resolved signals are never returned. The caller supplies only a
 * page bound; the database decides ordering, and malformed rows fail closed
 * rather than being projected.
 */
export const readOpenOperationsAlertSignals = async (
  limit = 100,
  dependencies: OperationsAlertSinkDependencies = {},
): Promise<readonly OperationsAlertSignal[]> => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const rows = await runtimeTransaction(async (transaction) =>
    transaction.query<AlertSignalRow>`
      select signal_id, code, severity, affected_service, deduplication_key,
        owning_role, runbook_reference, occurrence_count, first_seen_at,
        last_seen_at, state
      from vortex_operations.read_open_alert_signals(${limit}::integer)
    `,
  );

  return rows.map((row) =>
    operationsAlertSignalSchema.parse({
      signalId: row.signal_id,
      code: row.code,
      severity: row.severity,
      affectedService: row.affected_service,
      deduplicationKey: row.deduplication_key,
      owningRole: row.owning_role,
      runbookReference: row.runbook_reference,
      occurrenceCount: safeInteger(row.occurrence_count),
      firstSeenAt: isoInstant(row.first_seen_at),
      lastSeenAt: isoInstant(row.last_seen_at),
      state: row.state,
    }),
  );
};
