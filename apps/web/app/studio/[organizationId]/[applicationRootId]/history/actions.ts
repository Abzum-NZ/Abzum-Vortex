"use server";

import { inspectStudioApplicationReleaseHistory, listStudioApplicationReleaseHistory,
  type StudioApplicationHistoryInspectResult, type StudioApplicationHistoryListResult,
} from "../../../../_lib/studio-application-history";

/** Each command resolves its own actor, organization, root and saved revision on the server. */
export async function listApplicationReleaseHistory(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationHistoryListResult> {
  return listStudioApplicationReleaseHistory(organizationId, candidate);
}

export async function inspectApplicationReleaseHistory(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationHistoryInspectResult> {
  return inspectStudioApplicationReleaseHistory(organizationId, candidate);
}
