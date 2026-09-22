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
 */
export const createAppTelemetryCollector = (
  dependencies: AppTelemetryCollectorDependencies = {},
): ServiceTelemetryPort =>
  Object.freeze({
    appendTelemetry(input: TelemetryInput): void {
      const parsed = telemetryInputSchema.parse(input);
      dependencies.downstream?.appendTelemetry(
        Object.freeze({ ...parsed, counters: Object.freeze({ ...parsed.counters }) }),
      );
    },
    appendAlert(record: AlertRecord): void {
      const parsed = alertRecordSchema.parse(record);
      dependencies.downstream?.appendAlert(Object.freeze({ ...parsed }));
    },
  });
