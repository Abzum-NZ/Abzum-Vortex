"use server";

import { installSelectedStudioApplicationRelease } from "../../../../../../_lib/studio-application-installation";
import type { StudioApplicationInstallationCommandResult } from "../../../../../../_lib/studio-application-installation-contracts";

export async function installSelectedApplicationRelease(
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationInstallationCommandResult> {
  return installSelectedStudioApplicationRelease(organizationId, candidate);
}
