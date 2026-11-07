"use server";

import { logRefusal } from "@vortex/platform/server";
import {
  readStudioActionFlows as readFlows,
  type StudioActionFlowsResult,
} from "../_lib/studio-action-flows";

/**
 * The App Store's page for this application and the action flows the editor may start on it, as
 * the signed-in person sees them. It reads only; each flow runs through the flow endpoint, which
 * decides everything again.
 */
export async function readStudioActionFlows(
  organizationId: string,
  rootId: string,
): Promise<StudioActionFlowsResult> {
  try {
    return await readFlows(organizationId, rootId);
  } catch (error) {
    logRefusal("studio", "action flows", "read_failed", error);
    return { kind: "temporarily_unavailable" };
  }
}
