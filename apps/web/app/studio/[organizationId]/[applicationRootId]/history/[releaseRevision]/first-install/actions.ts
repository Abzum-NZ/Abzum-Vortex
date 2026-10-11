"use server";

import {
  activateStudioApplicationFirstInstall,
  loadStudioApplicationArchiveOptions,
  loadStudioApplicationFirstInstall,
  prepareStudioApplicationFirstInstall,
  saveStudioApplicationFirstInstallPolicy,
} from "../../../../../../_lib/studio-application-installation";
import type {
  StudioApplicationArchiveOptionsResult,
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

export async function readFirstInstallArchiveOptions(
  organizationId: string,
  query: unknown,
): Promise<StudioApplicationArchiveOptionsResult> {
  return loadStudioApplicationArchiveOptions(organizationId, query);
}

export async function saveFirstInstallPolicy(
  organizationId: string,
  command: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> {
  return saveStudioApplicationFirstInstallPolicy(organizationId, command);
}

export async function activateFirstInstall(
  organizationId: string,
  command: unknown,
): Promise<StudioApplicationFirstInstallCommandResult> {
  return activateStudioApplicationFirstInstall(organizationId, command);
}
