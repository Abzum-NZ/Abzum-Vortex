export const guidedFormConfirmationKey = "$guidedFormConfirmation";
export const guidedFormConfirmationReference = (
  candidate: unknown,
):
  | Readonly<{ draftId: string; revision: number; issuedAt: number; signature: string }>
  | undefined => {
  if (typeof candidate !== "string") return undefined;
  const match = /^([0-9a-f-]{36})\.([1-9][0-9]*)\.([0-9]{10})\.([0-9a-f]{64})$/u.exec(candidate);
  if (match === null) return undefined;
  const revision = Number(match[2]);
  const issuedAt = Number(match[3]);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(issuedAt)) return undefined;
  return { draftId: match[1]!, revision, issuedAt, signature: match[4]! };
};
