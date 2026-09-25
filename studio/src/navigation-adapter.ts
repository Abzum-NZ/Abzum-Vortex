import {
  builderKeySchema,
  containedComponentIdSchema,
  labelSchema,
  namespacedKeySchema,
  navigationItemSchema,
  pageIdSchema,
  safeHttpsUrlSchema,
  type ContainedComponentId,
  type NavigationItem,
} from "@vortex/contracts";

/**
 * The Studio navigation editing surface. It maps an application's canonical navigation tree to the
 * authored shape a builder edits and back, without persisting: the caller applies the returned
 * canonical tree through the same revision-checked draft operation that saves every other Studio
 * edit, so the adapter never reads, stores or advances a revision. Menu permission filtering stays
 * on the server (`runtime/page`); this surface only refuses an item the platform itself would
 * reject. Both directions are lossless: identity, order, labels, permission requirements and
 * targets survive a full round trip unchanged.
 */

/**
 * One navigation item as the Studio edits it. It is the authored navigation shape: a page link
 * names the application page by its builder key and every link carries the permission that governs
 * its visibility. The item keeps its canonical contained-component identity so editing neither
 * invents a new identity nor loses the one the draft already holds.
 */
export type StudioNavigationItem =
  | Readonly<{
      id: ContainedComponentId;
      type: "heading";
      label: string;
      children: readonly StudioNavigationItem[];
    }>
  | Readonly<{
      id: ContainedComponentId;
      type: "page";
      label: string;
      page: string;
      permission: string;
    }>
  | Readonly<{
      id: ContainedComponentId;
      type: "external";
      label: string;
      address: string;
      permission: string;
    }>;

/** One application page a navigation link may name: permanent identity and authored key. */
export type StudioNavigationPage = Readonly<{ pageId: string; key: string }>;

export class VortexNavigationAdapterError extends Error {
  override readonly name = "VortexNavigationAdapterError";
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The maximum children one level may hold, matching the authored navigation contract. */
const maximumNavigationItems = 100;

const copy = <T>(value: T, at: string): T => {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new VortexNavigationAdapterError(`Failed to clone navigation adapter data at ${at}`, {
      cause: error,
    });
  }
};

const asArray = (value: unknown, at: string): unknown[] => {
  if (!Array.isArray(value))
    throw new VortexNavigationAdapterError(`Invalid navigation adapter data at ${at}`);
  return value;
};

const asObject = (value: unknown, at: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new VortexNavigationAdapterError(`Invalid navigation adapter data at ${at}`);
  return value as Record<string, unknown>;
};

const exact = (value: unknown, keys: readonly string[], at: string): Record<string, unknown> => {
  const result = asObject(value, at);
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new VortexNavigationAdapterError(`Private or transient navigation data at ${at}`);
  return result;
};

const bounded = (items: readonly unknown[], at: string): void => {
  if (items.length > maximumNavigationItems)
    throw new VortexNavigationAdapterError(`Too many navigation items at ${at}`);
};

/** Runs one shared contract validator and converts a refusal into an operator-readable error. */
const validated = <T>(check: () => T, at: string): T => {
  try {
    return check();
  } catch (error) {
    throw new VortexNavigationAdapterError(`Invalid navigation adapter data at ${at}`, {
      cause: error,
    });
  }
};

const requiredChild = <T>(items: readonly T[], at: string): void => {
  if (items.length === 0)
    throw new VortexNavigationAdapterError(`A navigation heading needs at least one child at ${at}`);
  bounded(items, at);
};

/** Creates the pure navigation adapter over the application pages a builder may link to. */
export const createVortexNavigationAdapterV2 = (
  pagesInput: readonly StudioNavigationPage[] = [],
) => {
  const keyByIdentity = new Map<string, string>();
  const identityByKey = new Map<string, string>();
  for (const [index, page] of pagesInput.entries()) {
    const pageId = validated(() => pageIdSchema.parse(page.pageId), `pages[${index}].pageId`);
    const key = validated(() => builderKeySchema.parse(page.key), `pages[${index}].key`);
    if (keyByIdentity.has(pageId))
      throw new VortexNavigationAdapterError(`Duplicate application page identity ${pageId}`);
    if (identityByKey.has(key))
      throw new VortexNavigationAdapterError(`Duplicate application page key ${key}`);
    keyByIdentity.set(pageId, key);
    identityByKey.set(key, pageId);
  }

  const toEditorItem = (
    raw: unknown,
    at: string,
    seen: Set<string>,
  ): StudioNavigationItem => {
    const item = validated(() => navigationItemSchema.parse(raw), at);
    if (seen.has(item.id))
      throw new VortexNavigationAdapterError(`Duplicate navigation item identity ${item.id}`);
    seen.add(item.id);
    const id = item.id;
    switch (item.type) {
      case "heading":
        requiredChild(item.children, at);
        return {
          id,
          type: "heading",
          label: item.label,
          children: item.children.map((child, index) =>
            toEditorItem(child, `${at}.children[${index}]`, seen),
          ),
        };
      case "page": {
        const key = keyByIdentity.get(item.pageId);
        if (key === undefined)
          throw new VortexNavigationAdapterError(
            `Unknown application page identity ${item.pageId}`,
          );
        return {
          id,
          type: "page",
          label: item.label,
          page: key,
          permission: item.permissionKey,
        };
      }
      case "external":
        return {
          id,
          type: "external",
          label: item.label,
          address: item.address,
          permission: item.permissionKey,
        };
    }
  };

  const toEditor = (navigationInput: unknown): readonly StudioNavigationItem[] => {
    const navigation = asArray(copy(navigationInput, "navigation"), "navigation");
    bounded(navigation, "navigation");
    const seen = new Set<string>();
    return navigation.map((item, index) => toEditorItem(item, `${index}`, seen));
  };

  const fromEditorItem = (raw: unknown, at: string, seen: Set<string>): NavigationItem => {
    const node = asObject(raw, at);
    const id = validated(() => containedComponentIdSchema.parse(node.id), `${at}.id`);
    if (seen.has(id))
      throw new VortexNavigationAdapterError(`Duplicate navigation item identity ${id}`);
    seen.add(id);
    const label = validated(() => labelSchema.parse(node.label), `${at}.label`);
    if (node.type === "heading") {
      exact(node, ["id", "type", "label", "children"], at);
      const children = asArray(node.children, `${at}.children`);
      requiredChild(children, `${at}.children`);
      const assembled: NavigationItem = {
        id,
        type: "heading",
        label,
        children: children.map((child, index) =>
          fromEditorItem(child, `${at}.children[${index}]`, seen),
        ),
      };
      return validated(() => navigationItemSchema.parse(assembled), at);
    }
    if (node.type === "page") {
      exact(node, ["id", "type", "label", "page", "permission"], at);
      const key = validated(() => builderKeySchema.parse(node.page), `${at}.page`);
      const permissionKey = validated(
        () => namespacedKeySchema.parse(node.permission),
        `${at}.permission`,
      );
      const pageId = identityByKey.get(key);
      if (pageId === undefined)
        throw new VortexNavigationAdapterError(`Unknown application page key ${key}`);
      const assembled: NavigationItem = {
        id,
        type: "page",
        label,
        pageId: pageIdSchema.parse(pageId),
        permissionKey,
      };
      return validated(() => navigationItemSchema.parse(assembled), at);
    }
    if (node.type === "external") {
      exact(node, ["id", "type", "label", "address", "permission"], at);
      const address = validated(() => safeHttpsUrlSchema.parse(node.address), `${at}.address`);
      const permissionKey = validated(
        () => namespacedKeySchema.parse(node.permission),
        `${at}.permission`,
      );
      const assembled: NavigationItem = { id, type: "external", label, address, permissionKey };
      return validated(() => navigationItemSchema.parse(assembled), at);
    }
    throw new VortexNavigationAdapterError(`Invalid navigation item type at ${at}`);
  };

  const fromEditor = (input: unknown): readonly NavigationItem[] => {
    const navigation = asArray(copy(input, "navigation"), "navigation");
    bounded(navigation, "navigation");
    const seen = new Set<string>();
    return navigation.map((item, index) => fromEditorItem(item, `${index}`, seen));
  };

  return Object.freeze({ toEditor, fromEditor });
};
