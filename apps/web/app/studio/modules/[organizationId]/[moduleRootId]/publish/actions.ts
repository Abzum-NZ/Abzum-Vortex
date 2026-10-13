"use server";

import {
  prepareHumanDefinitionPublication,
  publishHumanDefinition,
} from "../../../../../_lib/definition-publication";

export async function prepareStudioModulePublication(organizationId: string, candidate: unknown) {
  return prepareHumanDefinitionPublication(organizationId, candidate, "module");
}

export async function publishStudioModule(organizationId: string, candidate: unknown) {
  return publishHumanDefinition(organizationId, candidate, "module");
}
