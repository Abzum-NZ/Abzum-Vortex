import type { BlockId, SemanticVersion } from "../catalogue/identifiers";
import type { PlatformBlockRelease } from "./application-composition/platform-block-release";
import { compiledItemSettings } from "./application-composition/page-composition";
import { releaseSettingDeclarations } from "./application-composition/platform-block-release";
import { sameCanonicalValue } from "./canonical-json-definition";
import type { PrepareDefinitionPublicationResult } from "./definition-store-contracts";

type ComponentLabel = Readonly<
  Omit<PrepareDefinitionPublicationResult["componentLabels"][number], "componentId" | "pageId"> & {
    componentId: string;
    pageId?: string;
  }
>;

const textKeys = ["label", "name", "singularLabel"] as const;
const identityKeyPattern = /^(?:[a-z]+(?:[A-Z][a-z]*)*)Id$/;
const identityKeys: Readonly<Record<string, string>> = {
  moduleBindings: "moduleRootId",
  dependencies: "moduleRootId",
  sharingConditions: "conditionId",
  publicAddresses: "addressId",
  flows: "id",
  nodes: "id",
  edges: "id",
  navigation: "id",
  children: "id",
  steps: "id",
};

const singular = (word: string): string =>
  word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : /(?:sses|xes|ches|shes)$/.test(word)
      ? word.slice(0, -2)
      : word.endsWith("s")
        ? word.slice(0, -1)
        : word;

/** An object's own contained id or kind-specific identity, never an identity it references. */
const ownedIdentity = (
  record: Record<string, unknown>,
  container: string | undefined,
): string | undefined => {
  if (container === undefined) return undefined;
  const identityKey = identityKeys[container];
  if (identityKey !== undefined && typeof record[identityKey] === "string")
    return record[identityKey];
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

const readableKey = (value: unknown): string | undefined => {
  const words = text(value)?.replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return words === undefined ? undefined : words[0]!.toUpperCase() + words.slice(1);
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
  return itemLabel ?? release.name;
};

/**
 * The authored name of every named component in the given compiled definitions, so a review reads
 * names, not ids. Each object is named only under the identity it owns. Earlier documents win;
 * later ones (the previous release) supply names for components that were removed. Placements use
 * their own label, else their block release's display name; flows use their authored name. Roles,
 * menu links and placements also carry the access, page, capability and wording facts that explain
 * their change against the previous release.
 */
export const componentLabelsOf = async (
  readBlockRelease: (
    blockId: BlockId,
    releaseVersion: SemanticVersion,
  ) => Promise<PlatformBlockRelease | undefined>,
  ...documents: readonly unknown[]
): Promise<readonly ComponentLabel[]> => {
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
    if (typeof record.blockId === "string" && typeof record.releaseVersion === "string")
      blocks.set(`${record.blockId}@${record.releaseVersion}`, {
        blockId: record.blockId as BlockId,
        releaseVersion: record.releaseVersion as SemanticVersion,
      });
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
  const visit = (
    value: unknown,
    container: string | undefined,
    entryOfCollection = false,
  ): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, container, true);
      return;
    }
    const record = asRecord(value);
    if (record === undefined) return;
    if (
      typeof record.blockId === "string" &&
      typeof record.releaseVersion === "string" &&
      !labels.has(record.blockId.toLowerCase())
    )
      labels.set(
        record.blockId.toLowerCase(),
        releases.get(`${record.blockId}@${record.releaseVersion}`)!.name,
      );
    const content = asRecord(record.content);
    const envelope = asRecord(record.envelope);
    if (
      typeof envelope?.rootId === "string" &&
      content !== undefined &&
      text(content.name) !== undefined &&
      !labels.has(envelope.rootId.toLowerCase())
    )
      labels.set(envelope.rootId.toLowerCase(), text(content.name)!);
    const block = blockReference(record);
    if (block !== undefined && !labels.has(block.id.toLowerCase())) {
      const release = releases.get(`${block.blockId}@${block.releaseVersion}`)!;
      labels.set(block.id.toLowerCase(), blockLabel(release, block.props));
    }
    const textKey = textKeys.find((key) => text(record[key]) !== undefined);
    const identity = entryOfCollection ? ownedIdentity(record, container) : undefined;
    const label =
      (textKey === undefined ? undefined : text(record[textKey])) ??
      text(asRecord(record.labels)?.name) ??
      readableKey(record.key);
    if (label !== undefined && identity !== undefined && !labels.has(identity.toLowerCase()))
      labels.set(identity.toLowerCase(), label);
    for (const [key, entry] of Object.entries(record)) visit(entry, key);
  };
  for (const document of documents) visit(document, undefined);
  const labelBindings = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) labelBindings(entry);
      return;
    }
    const record = asRecord(value);
    if (record === undefined) return;
    if (
      typeof record.bindingId === "string" &&
      typeof record.controlId === "string" &&
      typeof record.eventId === "string" &&
      !labels.has(record.bindingId.toLowerCase())
    ) {
      const control = labels.get(record.controlId.toLowerCase());
      const event = labels.get(record.eventId.toLowerCase()) ?? readableKey(record.event);
      if (control !== undefined && event !== undefined)
        labels.set(record.bindingId.toLowerCase(), `${control}: ${event}`);
    }
    for (const entry of Object.values(record)) labelBindings(entry);
  };
  for (const document of documents) labelBindings(document);

  // The candidate Application is first; its previous release follows the candidate's Modules.
  const contents = documents.flatMap((document) => {
    const record = asRecord(document);
    const content = asRecord(record?.content) ?? record;
    return content === undefined ? [] : [content];
  });
  const applications = contents.filter(
    (content) => Array.isArray(content.pages) && Array.isArray(content.roles),
  );
  const current = applications[0];
  const previous = applications[1];
  const details = new Map<string, Omit<ComponentLabel, "componentId" | "label">>();
  const permissionLabels = new Map<string, string>();
  for (const content of contents)
    for (const permission of (content.permissions as Record<string, unknown>[] | undefined) ?? [])
      if (
        typeof permission.key === "string" &&
        text(permission.label) !== undefined &&
        !permissionLabels.has(permission.key)
      )
        permissionLabels.set(permission.key, text(permission.label)!);
  for (const role of (current?.roles as Record<string, unknown>[] | undefined) ?? []) {
    const old = ((previous?.roles as Record<string, unknown>[] | undefined) ?? []).find(
      (entry) => String(entry.roleId).toLowerCase() === String(role.roleId).toLowerCase(),
    );
    if (old === undefined) continue;
    const before = new Set(old.permissionKeys as string[]);
    const after = new Set(role.permissionKeys as string[]);
    const names = (keys: readonly string[]) =>
      keys.flatMap((key) => {
        const label = permissionLabels.get(key);
        return label === undefined ? [] : [label];
      });
    details.set(String(role.roleId).toLowerCase(), {
      addedAccess: names([...after].filter((key) => !before.has(key))),
      removedAccess: names([...before].filter((key) => !after.has(key))),
    });
  }
  const navigation = (items: readonly Record<string, unknown>[]): void => {
    for (const item of items) {
      if (item.type === "page" && typeof item.id === "string" && typeof item.pageId === "string")
        details.set(item.id.toLowerCase(), { pageId: item.pageId.toLowerCase() });
      if (Array.isArray(item.children)) navigation(item.children as Record<string, unknown>[]);
    }
  };
  navigation((current?.navigation as Record<string, unknown>[] | undefined) ?? []);
  const placements = (content: Record<string, unknown> | undefined) => {
    const result = new Map<string, NonNullable<ReturnType<typeof blockReference>>>();
    const visitBlocks = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visitBlocks);
        return;
      }
      const record = asRecord(value);
      if (record === undefined) return;
      const block = blockReference(record);
      if (block !== undefined) result.set(block.id.toLowerCase(), block);
      Object.values(record).forEach(visitBlocks);
    };
    visitBlocks(content);
    return result;
  };
  const oldPlacements = placements(previous);
  const enabled = (value: unknown): boolean => {
    const group = asRecord(value);
    const setting = asRecord(asRecord(group?.properties)?.enabled);
    return group?.kind === "group" && setting?.kind === "boolean" && setting.value === true;
  };
  for (const [id, block] of placements(current)) {
    const old = oldPlacements.get(id);
    const release = releases.get(`${block.blockId}@${block.releaseVersion}`)!;
    if (old === undefined) continue;
    const changedSettings = releaseSettingDeclarations(release).filter(
      (property) =>
        !sameCanonicalValue(old.props[property.key] ?? null, block.props[property.key] ?? null),
    );
    if (
      changedSettings.length > 0 &&
      changedSettings.every((property) => property.kind === "text" || property.kind === "rich_text")
    )
      details.set(id, { wordingChanged: true });
    if (release.rendererKey !== "platform.renderer.table") continue;
    const oldRelease = releases.get(`${old.blockId}@${old.releaseVersion}`)!;
    const before = compiledItemSettings(old.props, oldRelease).features;
    const after = compiledItemSettings(block.props, release).features;
    const declaration = release.properties.find((property) => property.key === "features");
    if (after?.kind !== "group" || declaration?.kind !== "group") continue;
    const beforeProperties = before?.kind === "group" ? before.properties : {};
    details.set(id, {
      ...details.get(id),
      addedCapabilities: declaration.properties.flatMap((feature) =>
        enabled(after.properties[feature.key]) && !enabled(beforeProperties[feature.key])
          ? [feature.label]
          : [],
      ),
    });
  }
  return [...labels].map(([componentId, label]) => ({
    componentId,
    label,
    ...details.get(componentId),
  }));
};
