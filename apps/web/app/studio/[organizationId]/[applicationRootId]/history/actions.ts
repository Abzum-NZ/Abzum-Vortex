"use server";

import { listStudioApplicationReleaseHistory, type StudioApplicationHistoryListResult,
} from "../../../../_lib/studio-application-history";
import { restoreStudioApplicationDraft } from "../../../../_lib/studio-application-restore";
import type { StudioApplicationRestoreCommandResult } from "../../../../_lib/studio-application-restore-contracts";

/** Each command resolves its own actor, organization, root and saved revision on the server. */
export async function listApplicationReleaseHistory(
  organizationId: string, candidate: unknown,
): Promise<StudioApplicationHistoryListResult> {
  return listStudioApplicationReleaseHistory(organizationId, candidate);
}

/** Restores one published version into the draft as a new saved draft revision; nothing is published or installed. */
export async function restoreApplicationRelease(
  organizationId: string, command: unknown,
): Promise<StudioApplicationRestoreCommandResult> {
  return restoreStudioApplicationDraft(organizationId, command);
}
