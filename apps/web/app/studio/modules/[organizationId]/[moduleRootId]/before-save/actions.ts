"use server";

import {
  loadStudioModuleBeforeSaveCondition,
  saveStudioModuleBeforeSaveCondition,
  validateStudioModuleBeforeSaveCondition,
} from "../../../../../_lib/studio-module-before-save-condition";

export async function loadModuleBeforeSaveCondition(
  organizationId: string,
  moduleRootId: string,
  flowAlias?: string,
  taskId?: string,
) {
  return loadStudioModuleBeforeSaveCondition(organizationId, moduleRootId, flowAlias, taskId);
}

export async function validateModuleBeforeSaveCondition(organizationId: string, candidate: unknown) {
  return validateStudioModuleBeforeSaveCondition(organizationId, candidate);
}

export async function saveModuleBeforeSaveCondition(organizationId: string, candidate: unknown) {
  return saveStudioModuleBeforeSaveCondition(organizationId, candidate);
}
