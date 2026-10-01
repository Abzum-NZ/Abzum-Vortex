import { sameId } from "./runtime-primitives";

type PageReplacementEndpoint = Readonly<{
  identities: readonly string[];
  type: string;
  permission: string;
  replaces?: string | undefined;
  /** Omitted before resolution; null means a declared subject is still unresolved. */
  subject?: readonly [string, string] | null | undefined;
}>;

/** Inspect only declared endpoints in one Application, without selecting or rewriting a page. */
export const inspectApplicationPageReplacements = (
  pages: readonly PageReplacementEndpoint[],
): readonly Readonly<{
  index: number;
  kind: "identity" | "permission" | "relation";
  message: string;
}>[] => {
  const issues: {
    index: number;
    kind: "identity" | "permission" | "relation";
    message: string;
  }[] = [];
  const endpoints = new Map<string, Set<number>>();
  for (const [index, page] of pages.entries())
    for (const identity of page.identities) {
      const key = identity.toLowerCase();
      const matches = endpoints.get(key) ?? new Set<number>();
      matches.add(index);
      endpoints.set(key, matches);
    }
  const ambiguous = new Set<number>();
  for (const matches of endpoints.values())
    if (matches.size > 1) for (const index of matches) ambiguous.add(index);
  for (const index of ambiguous)
    issues.push({ index, kind: "identity", message: "Page endpoint identities must be unique" });

  const replacements = new Map<number, number>();
  for (const [index, page] of pages.entries()) {
    if (page.replaces === undefined) continue;
    const matches = endpoints.get(page.replaces.toLowerCase());
    if (matches?.size !== 1) {
      issues.push({
        index,
        kind: "relation",
        message: "A replacement must resolve exactly one retained page in the same application",
      });
      continue;
    }
    const originalIndex = matches.values().next().value!;
    const original = pages[originalIndex]!;
    if (originalIndex === index || original.replaces !== undefined)
      issues.push({
        index,
        kind: "relation",
        message: "Page replacements must be distinct and cannot form chains or cycles",
      });
    if (replacements.has(originalIndex))
      issues.push({
        index,
        kind: "relation",
        message: "A retained page may have at most one replacement",
      });
    replacements.set(originalIndex, index);
    if (page.type === "public" || original.type === "public" || page.type !== original.type)
      issues.push({
        index,
        kind: "relation",
        message: "Replacement endpoints must have the same non-public page type",
      });
    if (page.permission !== original.permission)
      issues.push({
        index,
        kind: "permission",
        message: "Replacement endpoints must have exactly the same access permission",
      });
    if (
      page.subject === null ||
      original.subject === null ||
      (page.subject === undefined) !== (original.subject === undefined) ||
      (page.subject !== undefined &&
        original.subject !== undefined &&
        (!sameId(page.subject[0], original.subject[0]) ||
          !sameId(page.subject[1], original.subject[1])))
    )
      issues.push({
        index,
        kind: "relation",
        message: "Replacement endpoints must have the same resolved Module and record-type subject",
      });
  }
  return issues;
};
