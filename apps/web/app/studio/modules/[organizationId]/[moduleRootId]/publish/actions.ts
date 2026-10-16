"use server";

import {
  loadHumanDefinitionPublicationDraft,
  prepareHumanDefinitionPublication,
  publishHumanDefinition,
} from "../../../../../_lib/definition-publication";

export async function loadStudioModulePublicationDraft(organizationId: string, moduleRootId: string) {
  return loadHumanDefinitionPublicationDraft(organizationId, moduleRootId, "module");
}

export async function prepareStudioModulePublication(organizationId: string, candidate: unknown) {
  return prepareHumanDefinitionPublication(organizationId, candidate, "module");
}

export async function publishStudioModule(organizationId: string, candidate: unknown) {
  return publishHumanDefinition(organizationId, candidate, "module");
}
