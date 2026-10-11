"use server";

import { redirect } from "next/navigation";
import { pageAdoptionCommandSchema } from "../../../../_lib/studio-standard-page-adoption-plan";
import { saveStudioStandardPageAdoption } from "../../../../_lib/studio-standard-page-adoption";

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

export async function submitStandardPageAdoption(formData: FormData): Promise<void> {
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
    redirect("/studio");
  const result = await saveStudioStandardPageAdoption(organizationId, parsed.data);
  const resultCode = result.kind === "available" ? "saved" : result.kind;
  redirect(
    `/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(parsed.data.rootId)}/page-adoption?result=${encodeURIComponent(resultCode)}`,
  );
}
