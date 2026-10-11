"use server";

import {
  loadStudioModuleTextFieldSettings,
  saveStudioModuleTextFieldSettings,
} from "../../../../../_lib/studio-module-text-field-settings";

export async function saveModuleTextFieldSettings(organizationId: string, candidate: unknown) {
  return saveStudioModuleTextFieldSettings(organizationId, candidate);
}

export async function reopenModuleTextFieldSettings(organizationId: string, moduleRootId: string) {
  return loadStudioModuleTextFieldSettings(organizationId, moduleRootId);
}
