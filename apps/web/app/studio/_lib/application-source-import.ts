import { z } from "zod";
import {
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  fingerprintSchema,
  definitionValidationResultSchema,
  organizationIdSchema,
  revisionSchema,
  canonicalJson,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";

export const maximumApplicationSourceImportBytes = 2 * 1024 * 1024;

export const studioApplicationSourceReviewRequestSchema = z.object({
  rootId: applicationRootIdSchema,
  expectedDraftRevision: revisionSchema,
  expectedSavedSourceFingerprint: fingerprintSchema,
  source: applicationSourceDocumentSchema,
}).strict();

const sourceReviewBinding = {
  organizationId: organizationIdSchema,
  rootId: applicationRootIdSchema,
  key: applicationSourceDocumentSchema.shape.key,
  rootAlias: applicationSourceDocumentSchema.shape.root_alias,
  draftRevision: revisionSchema,
  savedSourceFingerprint: fingerprintSchema,
  candidateSourceFingerprint: fingerprintSchema,
};

export const studioApplicationSourceReviewResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    ...sourceReviewBinding,
    source: applicationSourceDocumentSchema,
  }).strict(),
  z.object({
    kind: z.literal("validation_failed"),
    ...sourceReviewBinding,
    validation: definitionValidationResultSchema,
  }).strict(),
  z.object({
    kind: z.literal("identity_conflict"),
    ...sourceReviewBinding,
    conflicts: z.array(z.object({ kind: z.string(), name: z.string() }).strict()).min(1),
  }).strict(),
  z.object({ kind: z.literal("invalid") }).strict(),
  z.object({ kind: z.literal("conflict") }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable") }).strict(),
]);

export type StudioApplicationSourceReviewResult = z.infer<typeof studioApplicationSourceReviewResultSchema>;

/** A local editor frame, never a permission decision or a saved-draft receipt. */
export type StudioApplicationSourceImportSnapshot = Readonly<{
  organizationId: string; rootId: string; key: string; rootAlias: string;
  draftRevision: number; savedSourceFingerprint: string;
  source: ApplicationSourceDocument;
  localLifetime: number;
}>;

export const sameStudioApplicationSourceImportSnapshot = (
  expected: StudioApplicationSourceImportSnapshot,
  current: StudioApplicationSourceImportSnapshot | null,
): boolean => current !== null && expected.organizationId === current.organizationId &&
  expected.rootId === current.rootId && expected.key === current.key && expected.rootAlias === current.rootAlias &&
  expected.draftRevision === current.draftRevision && expected.savedSourceFingerprint === current.savedSourceFingerprint &&
  expected.localLifetime === current.localLifetime && canonicalJson(expected.source) === canonicalJson(current.source);

/** Inspect raw member names before JSON.parse can silently discard a duplicate. */
function hasUnambiguousMembers(text: string): boolean {
  const containers: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") containers.push(new Set());
    else if (character === "[") containers.push(null);
    else if (character === "}" || character === "]") containers.pop();
    else if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      if (index >= text.length) return false;
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] === ":") {
        const members = containers[containers.length - 1];
        if (members === undefined || members === null) return false;
        const name: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof name !== "string" || members.has(name)) return false;
        members.add(name);
        if (members.size > 1_000) return false;
      }
    }
    // The existing body bound is 32; the envelope adds the root and body containers.
    if (containers.length > 34) return false;
  }
  return true;
}

export function readStudioApplicationSourceImport(
  text: string, key: string, rootAlias: string,
): Readonly<{ kind: "valid"; source: ApplicationSourceDocument }> |
  Readonly<{ kind: "invalid"; message: string }> {
  if (text.length > maximumApplicationSourceImportBytes ||
    new TextEncoder().encode(text).byteLength > maximumApplicationSourceImportBytes)
    return { kind: "invalid", message: "The JSON source must be at most 2 MiB." };
  try {
    if (!hasUnambiguousMembers(text))
      return { kind: "invalid", message: "The JSON source has duplicate members or exceeds its nesting limit." };
    const input: unknown = JSON.parse(text);
    const parsed = applicationSourceDocumentSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return {
        kind: "invalid",
        message: `Use one valid authored Application source document in format 2.0.0 (${issue.path.join(".")}: ${issue.message}).`,
      };
    }
    if (parsed.data.key !== key || parsed.data.root_alias !== rootAlias)
      return { kind: "invalid", message: "The source must keep this draft's Application key and root alias." };
    return { kind: "valid", source: parsed.data };
  } catch {
    return { kind: "invalid", message: "The source could not be read as valid authored Application JSON." };
  }
}
