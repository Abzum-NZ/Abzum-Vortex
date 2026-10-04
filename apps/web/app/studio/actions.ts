"use server";

import {
  applicationSourceDocumentV2Schema,
  saveDefinitionDraftCommandSchema,
} from "@vortex/contracts";
import { validateDefinitionSource } from "@vortex/definition";
import { createHumanApplicationDraft, saveHumanApplicationDraft } from "../_lib/definition-draft-write";
import { loadStudioApplicationDraft } from "../_lib/studio-application-draft";

/** A browser document is authored input, never authority or evidence of an installed Module. */
export async function createStudioApplication(organizationId: string, candidate: unknown) {
  const source = applicationSourceDocumentV2Schema.safeParse(candidate);
  if (!source.success || !validateDefinitionSource(source.data).valid)
    return { kind: "refused" } as const;
  return createHumanApplicationDraft(organizationId, { source: source.data });
}

export async function saveStudioApplication(organizationId: string, candidate: unknown) {
  const command = saveDefinitionDraftCommandSchema.safeParse(candidate);
  if (!command.success || command.data.source.kind !== "application" ||
    !validateDefinitionSource(command.data.source).valid)
    return { kind: "refused" } as const;
  return saveHumanApplicationDraft(organizationId, command.data);
}

export async function reopenStudioApplication(organizationId: string, applicationRootId: string) {
  return loadStudioApplicationDraft(organizationId, applicationRootId);
}
