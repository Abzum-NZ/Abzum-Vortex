import "server-only";

import { alertRecordSchema, type AlertRecord, type ServiceTelemetryPort } from "../schema";
import { withRuntimeTransaction, type RequestDatabaseTransaction } from "../db/index";

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

export interface OperationsAlertSinkDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
}

/**
 * At most this many signal writes are in flight across every sink in the
 * process. An alert storm then holds a small, fixed share of the runtime
 * connection pool instead of competing with the measured operations for every
 * connection; alerts beyond the bound are dropped, so occurrence counts are a
 * lower bound.
 */
const maximumInFlightSignalWrites = 2;
let inFlightSignalWrites = 0;

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
 * without awaiting it, within the process-wide in-flight bound.
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
      if (!parsed.success || inFlightSignalWrites >= maximumInFlightSignalWrites) return;
      inFlightSignalWrites += 1;
      void persistAlertSignal(runtimeTransaction, parsed.data)
        .catch(() => undefined)
        .finally(() => {
          inFlightSignalWrites -= 1;
        });
    },
  });
};

