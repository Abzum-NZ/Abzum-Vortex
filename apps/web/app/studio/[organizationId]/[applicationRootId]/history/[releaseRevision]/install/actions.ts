"use server";

import {
  installSelectedStudioApplicationRelease,
  loadStudioApplicationInstallation,
} from "../../../../../../_lib/studio-application-installation";
import type {
  StudioApplicationInstallationCommandResult,
  StudioApplicationInstallationLoadResult,
} from "../../../../../../_lib/studio-application-installation-contracts";

export async function installSelectedApplicationRelease(
  organizationId: string,
  candidate: unknown,
): Promise<Readonly<{
  command: StudioApplicationInstallationCommandResult;
  load: StudioApplicationInstallationLoadResult;
}>> {
  const command = await installSelectedStudioApplicationRelease(organizationId, candidate);
  const selector = (candidate as { selector?: unknown } | null)?.selector;
  const load = await loadStudioApplicationInstallation(organizationId, selector);
  return { command, load };
}
