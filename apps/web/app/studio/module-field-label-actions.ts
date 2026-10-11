"use server";

import { loadStudioModuleFieldLabel, saveStudioModuleFieldLabel } from "../_lib/studio-module-field-label";

export async function saveModuleFieldLabel(organizationId: string, candidate: unknown) {
  return saveStudioModuleFieldLabel(organizationId, candidate);
}

export async function reopenModuleFieldLabel(organizationId: string, moduleRootId: string) {
  return loadStudioModuleFieldLabel(organizationId, moduleRootId);
}
