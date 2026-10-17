import type { BlockId, PlatformBlockRelease, SemanticVersion } from "../schema";

const textKeys = ["label", "name", "singularLabel"] as const;
const identityKeyPattern = /^(?:[a-z]+(?:[A-Z][a-z]*)*)Id$/;

const singular = (word: string): string =>
  word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : /(?:sses|xes|ches|shes)$/.test(word)
      ? word.slice(0, -2)
      : word.endsWith("s")
        ? word.slice(0, -1)
        : word;

/** The identity an object owns: `<singular of its array property>Id`, or a key that names the same kind (e.g. `bindingId` in `connectionBindings`). */
const ownedIdentity = (
  record: Record<string, unknown>,
  container: string | undefined,
): string | undefined => {
  if (container === undefined) return undefined;
  const expected = `${singular(container)}Id`.toLowerCase();
  const matches = Object.keys(record).filter((key) => {
    if (
      key === "organizationId" ||
      !identityKeyPattern.test(key) ||
      typeof record[key] !== "string"
    )
      return false;
    const actual = key.toLowerCase();
    return actual === expected || actual.endsWith(expected) || expected.endsWith(actual);
  });
  return matches.length === 1 ? (record[matches[0]!] as string) : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const readableKey = (value: unknown): string => {
  const words = text(value)?.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return words === undefined ? "Flow" : words[0]!.toUpperCase() + words.slice(1);
};

const blockReference = (
  record: Record<string, unknown>,
):
  | Readonly<{
      id: string;
      blockId: BlockId;
      releaseVersion: SemanticVersion;
      props: Record<string, unknown>;
    }>
  | undefined => {
  const props = asRecord(record.props);
  const block = asRecord(asRecord(props?.vortex)?.block);
  return typeof props?.id === "string" &&
    typeof block?.blockId === "string" &&
    typeof block.releaseVersion === "string"
    ? {
        id: props.id,
        blockId: block.blockId as BlockId,
        releaseVersion: block.releaseVersion as SemanticVersion,
        props,
      }
    : undefined;
};

const blockLabel = (release: PlatformBlockRelease, props: Record<string, unknown>): string => {
  const accessible =
    release.capabilities.accessibleName === "not_applicable"
      ? undefined
      : release.capabilities.accessibleNamePropertyPath[0];
  const named = release.properties.find((property) => property.key === accessible);
  const label =
    named?.kind === "text" || named?.kind === "choice" ? text(props[accessible!]) : undefined;
  const firstText = release.properties.find(
    (property) => property.kind === "text" && text(props[property.key]) !== undefined,
  );
  const itemLabel = label ?? (firstText === undefined ? undefined : text(props[firstText.key]));
  return itemLabel === undefined ? release.name : `${release.name}: ${itemLabel}`;
};

/**
 * The authored name of every named component in the given compiled definitions, so a review reads
 * names, not ids. Each object is named only under the identity it owns. Earlier documents win;
 * later ones (the previous release) supply names for components that were removed. Placements use
 * their block release's display name and their own label; flows use their authored name.
 */
export const componentLabelsOf = async (
  readBlockRelease: (
    blockId: BlockId,
    releaseVersion: SemanticVersion,
  ) => Promise<PlatformBlockRelease | undefined>,
  ...documents: readonly unknown[]
): Promise<ReadonlyArray<Readonly<{ componentId: string; label: string }>>> => {
  const blocks = new Map<string, Readonly<{ blockId: BlockId; releaseVersion: SemanticVersion }>>();
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    const record = asRecord(value);
    if (record === undefined) return;
    const block = blockReference(record);
    if (block !== undefined) blocks.set(`${block.blockId}@${block.releaseVersion}`, block);
    for (const entry of Object.values(record)) scan(entry);
  };
  for (const document of documents) scan(document);
  const releases = new Map<string, PlatformBlockRelease>();
  await Promise.all(
    [...blocks.entries()].map(async ([key, block]) => {
      const release = await readBlockRelease(block.blockId, block.releaseVersion);
      if (release === undefined)
        throw new Error(`Publication label cannot find block release ${key}`);
      releases.set(key, release);
    }),
  );

  const labels = new Map<string, string>();
  const visit = (value: unknown, container: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, container);
      return;
    }
    const record = asRecord(value);
    if (record === undefined) return;
    const block = blockReference(record);
    if (block !== undefined && !labels.has(block.id.toLowerCase())) {
      const release = releases.get(`${block.blockId}@${block.releaseVersion}`)!;
      labels.set(block.id.toLowerCase(), blockLabel(release, block.props));
    }
    if (
      container === "flows" &&
      typeof record.id === "string" &&
      !labels.has(record.id.toLowerCase())
    ) {
      labels.set(
        record.id.toLowerCase(),
        text(asRecord(record.labels)?.name) ?? readableKey(record.key),
      );
    }
    const textKey = textKeys.find((key) => text(record[key]) !== undefined);
    const identity = textKey === undefined ? undefined : ownedIdentity(record, container);
    if (textKey !== undefined && identity !== undefined && !labels.has(identity.toLowerCase()))
      labels.set(identity.toLowerCase(), text(record[textKey])!);
    for (const [key, entry] of Object.entries(record)) visit(entry, key);
  };
  for (const document of documents) visit(document, undefined);
  return [...labels].map(([componentId, label]) => ({ componentId, label }));
};
