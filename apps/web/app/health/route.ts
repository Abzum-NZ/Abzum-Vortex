import { randomUUID } from "node:crypto";
import {
  clampTelemetryDurationMs,
  correlationIdSchema,
  countersForOutcome,
} from "@vortex/contracts";
import { createAppTelemetryCollector } from "@vortex/app";

const telemetry = createAppTelemetryCollector();

/**
 * Health answers a fixed safe status and has no failure outcome of its own. Measuring it
 * must never introduce one, so every telemetry step is contained here. Health is not a
 * protected request, so each observation carries its own correlation identifier.
 */
const appendHealthTelemetry = (startedAtMs: number): void => {
  try {
    telemetry.appendTelemetry({
      correlationId: correlationIdSchema.parse(randomUUID()),
      service: "web",
      operation: "health",
      outcome: "success",
      durationMs: clampTelemetryDurationMs(startedAtMs, Date.now()),
      counters: countersForOutcome("success"),
    });
  } catch {
    // Telemetry must not change the health response.
  }
};

export function GET() {
  const startedAt = Date.now();
  const response = Response.json({ status: "ok", service: "vortex-web" });
  appendHealthTelemetry(startedAt);
  return response;
}
