const textKeys = ["label", "name", "singularLabel"] as const;
const identityKeyPattern = /^(?:[a-z]+(?:[A-Z][a-z]*)*)Id$/;

const singular = (word: string): string =>
  word.endsWith("ies") ? `${word.slice(0, -3)}y`
    : /(?:sses|xes|ches|shes)$/.test(word) ? word.slice(0, -2)
      : word.endsWith("s") ? word.slice(0, -1) : word;

/** The identity an object owns: `<singular of its array property>Id`, or a key that names the same kind (e.g. `bindingId` in `connectionBindings`). */
const ownedIdentity = (record: Record<string, unknown>, container: string | undefined): string | undefined => {
  if (container === undefined) return undefined;
  const expected = `${singular(container)}Id`.toLowerCase();
  const matches = Object.keys(record).filter((key) => {
    if (key === "organizationId" || !identityKeyPattern.test(key) || typeof record[key] !== "string") return false;
    const actual = key.toLowerCase();
    return actual === expected || actual.endsWith(expected) || expected.endsWith(actual);
  });
  return matches.length === 1 ? (record[matches[0]!] as string) : undefined;
};

/**
 * The authored name of every named component in the given compiled definitions, so a review reads
 * names, not ids. Each object is named only under the identity it owns (its array property's
 * singular `Id` or a key naming the same kind), never under identities it merely references. Earlier
 * documents win; later ones (the previous release) supply names for components that were removed.
 */
export const componentLabelsOf = (
  ...documents: readonly unknown[]
): ReadonlyArray<Readonly<{ componentId: string; label: string }>> => {
  const labels = new Map<string, string>();
  const visit = (value: unknown, container: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, container);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const textKey = textKeys.find((key) => typeof record[key] === "string" && (record[key] as string).trim().length > 0);
    const identity = textKey === undefined ? undefined : ownedIdentity(record, container);
    if (textKey !== undefined && identity !== undefined && !labels.has(identity.toLowerCase()))
      labels.set(identity.toLowerCase(), (record[textKey] as string).trim());
    for (const [key, entry] of Object.entries(record)) visit(entry, key);
  };
  for (const document of documents) visit(document, undefined);
  return [...labels].map(([componentId, label]) => ({ componentId, label }));
};
