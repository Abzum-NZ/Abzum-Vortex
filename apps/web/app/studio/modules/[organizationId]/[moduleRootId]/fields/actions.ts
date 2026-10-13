"use server";

import { loadStudioModuleFieldLabel, saveStudioModuleFieldChange } from "../../../../../_lib/studio-module-field-label";
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

export async function saveModuleFieldChange(organizationId: string, candidate: unknown) {
  return saveStudioModuleFieldChange(organizationId, candidate);
}

export async function reopenModuleFields(organizationId: string, moduleRootId: string) {
  return loadStudioModuleFieldLabel(organizationId, moduleRootId);
}
