"use server";

import {
  loadStudioModuleQueryFilter,
  saveStudioModuleQueryFilter,
  validateStudioModuleQueryFilter,
} from "../../../../../_lib/studio-module-query-filter";

export async function loadModuleQueryFilter(
  organizationId: string,
  moduleRootId: string,
  queryAlias?: string,
) {
  return loadStudioModuleQueryFilter(organizationId, moduleRootId, queryAlias);
}

export async function validateModuleQueryFilter(organizationId: string, candidate: unknown) {
  return validateStudioModuleQueryFilter(organizationId, candidate);
}

export async function saveModuleQueryFilter(organizationId: string, candidate: unknown) {
  return saveStudioModuleQueryFilter(organizationId, candidate);
}
