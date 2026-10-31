import {
  namedActionAvailabilityResultSchema,
  type NamedActionAvailability,
} from "@vortex/platform/schema";
import { postJson } from "../../../../../../_lib/post-json";

/** Loaded on selection intent, with one response covering every declared action. */
export async function readActionAvailability(
  body: unknown,
  signal: AbortSignal,
): Promise<NamedActionAvailability> {
  const response = await postJson("/api/records-table/action-availability", body, { signal });
  const result = namedActionAvailabilityResultSchema.parse(response.body);
  if (!response.ok || result.kind !== "available")
    throw new Error(`ACTION_AVAILABILITY_${result.kind}: ${response.status}`);
  return result.records;
}
