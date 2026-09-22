import "server-only";

import {
  alertRecordSchema,
  telemetryInputSchema,
  type AlertRecord,
  type ServiceTelemetryPort,
  type TelemetryInput,
} from "@vortex/contracts";

export type AppTelemetryCollectorDependencies = Readonly<{
  downstream?: ServiceTelemetryPort;
}>;

/**
 * The server-only App boundary for telemetry and alerts. Runtime validation is repeated at
 * this boundary so a structurally typed caller cannot smuggle extra or sensitive fields into
 * the downstream Operations consumer.
 *
 * Collection is a side channel: a record that fails validation is dropped and a failing
 * downstream is contained, so appending telemetry can never change the safe outcome of the
 * operation being measured. The deployment environment is a property of the downstream
 * destination rather than of each accepted record.
 */
export const createAppTelemetryCollector = (
  dependencies: AppTelemetryCollectorDependencies = {},
): ServiceTelemetryPort =>
  Object.freeze({
    appendTelemetry(input: TelemetryInput): void {
      const parsed = telemetryInputSchema.safeParse(input);
      if (!parsed.success) return;
      try {
        dependencies.downstream?.appendTelemetry(
          Object.freeze({ ...parsed.data, counters: Object.freeze({ ...parsed.data.counters }) }),
        );
      } catch {
        // A failing consumer never propagates back into the measured operation.
      }
    },
    appendAlert(record: AlertRecord): void {
      const parsed = alertRecordSchema.safeParse(record);
      if (!parsed.success) return;
      try {
        dependencies.downstream?.appendAlert(Object.freeze({ ...parsed.data }));
      } catch {
        // A failing consumer never propagates back into the measured operation.
      }
    },
  });
