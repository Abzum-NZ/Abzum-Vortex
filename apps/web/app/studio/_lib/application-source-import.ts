import { z } from "zod";
import {
  applicationRootIdSchema,
  applicationSourceDocumentV2Schema,
  fingerprintSchema,
  organizationIdSchema,
  revisionSchema,
  canonicalJson,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";

export const maximumApplicationSourceImportBytes = 2 * 1024 * 1024;

export const studioApplicationSourceReviewRequestSchema = z.object({
  rootId: applicationRootIdSchema,
  expectedDraftRevision: revisionSchema,
  expectedSavedSourceFingerprint: fingerprintSchema,
  source: applicationSourceDocumentV2Schema,
}).strict();

export const studioApplicationSourceReviewResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    key: applicationSourceDocumentV2Schema.shape.key,
    rootAlias: applicationSourceDocumentV2Schema.shape.root_alias,
    draftRevision: revisionSchema,
    savedSourceFingerprint: fingerprintSchema,
    candidateSourceFingerprint: fingerprintSchema,
    source: applicationSourceDocumentV2Schema,
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
  source: ApplicationSourceDocumentV2; selectionKey: string;
  localLifetime: number; generation: number;
}>;

export const sameStudioApplicationSourceImportSnapshot = (
  expected: StudioApplicationSourceImportSnapshot,
  current: StudioApplicationSourceImportSnapshot | null,
): boolean => current !== null && expected.organizationId === current.organizationId &&
  expected.rootId === current.rootId && expected.key === current.key && expected.rootAlias === current.rootAlias &&
  expected.draftRevision === current.draftRevision && expected.savedSourceFingerprint === current.savedSourceFingerprint &&
  expected.selectionKey === current.selectionKey && expected.localLifetime === current.localLifetime &&
  expected.generation === current.generation && canonicalJson(expected.source) === canonicalJson(current.source);

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
): Readonly<{ kind: "valid"; source: ApplicationSourceDocumentV2 }> |
  Readonly<{ kind: "invalid"; message: string }> {
  if (text.length > maximumApplicationSourceImportBytes ||
    new TextEncoder().encode(text).byteLength > maximumApplicationSourceImportBytes)
    return { kind: "invalid", message: "The JSON source must be at most 2 MiB." };
  try {
    if (!hasUnambiguousMembers(text))
      return { kind: "invalid", message: "The JSON source has duplicate members or exceeds its nesting limit." };
    const input: unknown = JSON.parse(text);
    const parsed = applicationSourceDocumentV2Schema.safeParse(input);
    if (!parsed.success)
      return { kind: "invalid", message: "Use one valid authored Application source document in format 2.0.0." };
    if (parsed.data.key !== key || parsed.data.root_alias !== rootAlias)
      return { kind: "invalid", message: "The source must keep this draft's Application key and root alias." };
    return { kind: "valid", source: parsed.data };
  } catch {
    return { kind: "invalid", message: "The source could not be read as valid authored Application JSON." };
  }
}
