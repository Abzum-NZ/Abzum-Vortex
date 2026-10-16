"use server";

import { pageAdoptionCommandSchema } from "../../../../_lib/studio-standard-page-adoption-plan";
import { loadStudioStandardPageAdoption, saveStudioStandardPageAdoption,
  type StudioStandardPageAdoptionLoadResult } from "../../../../_lib/studio-standard-page-adoption";

const textField = (formData: FormData, key: string): string | undefined => {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
};

const numberField = (formData: FormData, key: string): number | undefined => {
  const raw = textField(formData, key);
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Reads the comparison for the Page adoption tab; the server resolves access afresh. */
export async function readStandardPageAdoption(
  organizationId: string, rootId: string,
): Promise<StudioStandardPageAdoptionLoadResult> {
  return loadStudioStandardPageAdoption(organizationId, rootId);
}

/** Returns the outcome code ("saved", "conflict", ...) for the tab to show; the tab then reloads the comparison. */
export async function submitStandardPageAdoption(formData: FormData): Promise<string> {
  const organizationId = textField(formData, "organizationId");
  const rootId = textField(formData, "rootId");
  const targetKind = textField(formData, "targetKind");
  const targetId = textField(formData, "targetId");
  const parsed = pageAdoptionCommandSchema.safeParse({
    rootId,
    expectedDraftRevision: numberField(formData, "expectedDraftRevision"),
    expectedPublicationAnchor: numberField(formData, "expectedPublicationAnchor"),
    candidateReleaseRevision: numberField(formData, "candidateReleaseRevision"),
    originalPageId: textField(formData, "originalPageId"),
    replacementPageId: textField(formData, "replacementPageId"),
    comparisonFingerprint: textField(formData, "comparisonFingerprint"),
    decision: textField(formData, "decision"),
    target: { kind: targetKind, id: targetId },
  });
  if (organizationId === undefined || rootId === undefined || !parsed.success)
    return "refused";
  const result = await saveStudioStandardPageAdoption(organizationId, parsed.data);
  return result.kind === "available" ? "saved" : result.kind;
}
