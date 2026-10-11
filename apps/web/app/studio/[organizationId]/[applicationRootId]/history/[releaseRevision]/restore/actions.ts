"use server";

import {
  loadStudioApplicationRestore,
  restoreStudioApplicationDraft,
} from "../../../../../../_lib/studio-application-restore";
import type {
  StudioApplicationRestoreCommandResult,
  StudioApplicationRestoreLoadResult,
} from "../../../../../../_lib/studio-application-restore-contracts";

export async function reloadApplicationDraftRestore(
  organizationId: string,
  selector: unknown,
): Promise<StudioApplicationRestoreLoadResult> {
  return loadStudioApplicationRestore(organizationId, selector);
}

export async function restoreApplicationDraftFromRelease(
  organizationId: string,
  command: unknown,
): Promise<StudioApplicationRestoreCommandResult> {
  return restoreStudioApplicationDraft(organizationId, command);
}
