"use server";

import {
  activateStudioApplicationFirstInstall,
  loadStudioApplicationFirstInstall,
  prepareStudioApplicationFirstInstall,
} from "../../../../../../_lib/studio-application-installation";
import type {
  StudioApplicationFirstInstallCommandResult,
  StudioApplicationFirstInstallLoadResult,
} from "../../../../../../_lib/studio-application-installation-contracts";

export async function reloadFirstInstall(
  organizationId: string,
  selector: unknown,
): Promise<StudioApplicationFirstInstallLoadResult> {
  return loadStudioApplicationFirstInstall(organizationId, selector);
}

export async function prepareFirstInstall(
  organizationId: string,
  command: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> {
  return prepareStudioApplicationFirstInstall(organizationId, command);
}

export async function activateFirstInstall(
  organizationId: string,
  command: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> {
  return activateStudioApplicationFirstInstall(organizationId, command);
}
