import { randomUUID } from "node:crypto";
import { correlationIdSchema, type CorrelationId } from "@vortex/contracts";
import { createAppTelemetryCollector } from "@vortex/app";

const telemetry = createAppTelemetryCollector();

const appendHealthTelemetry = (
  correlationId: CorrelationId,
  outcome: "success" | "failure",
  startedAt: number,
): void => {
  try {
    telemetry.appendTelemetry({
      correlationId,
      service: "web",
      operation: "health",
      outcome,
      durationMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)),
      counters: {
        requestCount: 1,
        successCount: outcome === "success" ? 1 : 0,
        failureCount: outcome === "failure" ? 1 : 0,
        refusalCount: 0,
        retryCount: 0,
      },
    });
  } catch {
    // Telemetry must not change the health response's safe outcome.
  }
};

export function GET() {
  const startedAt = Date.now();
  const correlationId = correlationIdSchema.parse(randomUUID());
  try {
    const response = Response.json({ status: "ok", service: "vortex-web" });
    appendHealthTelemetry(correlationId, "success", startedAt);
    return response;
  } catch {
    appendHealthTelemetry(correlationId, "failure", startedAt);
    throw new Error("HEALTH_RESPONSE_UNAVAILABLE");
  }
}
