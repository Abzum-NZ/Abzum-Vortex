import {
  namedActionAvailabilityResultSchema,
  type NamedActionAvailability,
} from "@vortex/platform/schema";

/** Loaded on selection intent, with one response covering every declared action. */
export async function readActionAvailability(
  body: unknown,
  signal: AbortSignal,
): Promise<NamedActionAvailability> {
  const response = await fetch("/api/records-table/action-availability", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal,
    body: JSON.stringify(body),
  });
  const result = namedActionAvailabilityResultSchema.parse(await response.json());
  if (!response.ok || result.kind !== "available")
    throw new Error(`ACTION_AVAILABILITY_${result.kind}: ${response.status}`);
  return result.records;
}
