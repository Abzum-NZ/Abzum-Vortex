import { canonicalJson, type ApplicationSourceDocument, asRecord } from "@vortex/platform/schema";

export type SourceChangeRow = Readonly<{
  area: string;
  change: "Added" | "Removed" | "Changed";
  item: string;
}>;

/** The areas of an application a builder knows by name; any other area is named from its key. */
const areaLabels: Readonly<Record<string, string>> = {
  name: "Name",
  description: "Description",
  icon: "Icon",
  home_page: "Home page",
  search: "Search",
  modules: "Modules",
  uses: "Modules used",
  record_types: "Record types",
  fields: "Fields",
  permissions: "Permissions",
  roles: "Access groups",
  navigation: "Menu",
  shells: "Layouts",
  pages: "Pages",
  flows: "Flows",
  actions: "Actions",
  queries: "Queries",
  events: "Events",
  relationships: "Relationships",
  pipelines: "Pipelines",
  theme: "Appearance",
  platform_block_dependencies: "Item types used",
  connections: "Connections",
  flow_bindings: "Interactions",
  connection_bindings: "Connections",
  children: "Menu entries",
  steps: "Steps",
  tasks: "Steps",
};
const areaLabel = (key: string): string =>
  areaLabels[key] ?? key.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());

/** The name a person knows an entry by, from its own name or label; a key is the last resort. */
const itemName = (entry: unknown, index: number): string => {
  const fields = asRecord(entry);
  for (const field of ["name", "label", "key", "purpose", "module", "id"]) {
    const value = fields?.[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return `Entry ${index + 1}`;
};
const identity = (entry: unknown, index: number): string => {
  const fields = asRecord(entry);
  for (const field of ["key", "id", "module", "purpose"]) {
    const value = fields?.[field];
    if (typeof value === "string") return value;
  }
  return `#${index}`;
};

/** The array members of a source object whose own entries are named areas of the review. */
const isCollection = (key: string, value: unknown): value is readonly unknown[] =>
  Array.isArray(value) && Object.hasOwn(areaLabels, key);

/**
 * One collection's changes, then the changes inside every entry that stayed: a Module's record
 * types and fields, a record type's relationships, a page's blocks and bindings. An entry matched
 * by its key, then its id, so a component that moved between containers is still compared.
 */
const collectionChanges = (
  key: string,
  from: unknown,
  to: unknown,
  rows: SourceChangeRow[],
): void => {
  const area = areaLabel(key);
  const was = new Map<string, { entry: unknown; index: number }>();
  const now = new Map<string, { entry: unknown; index: number }>();
  for (const [entry, index] of (Array.isArray(from) ? from : []).map(
    (entry, index) => [entry, index] as const,
  ))
    was.set(identity(entry, index), { entry, index });
  for (const [entry, index] of (Array.isArray(to) ? to : []).map(
    (entry, index) => [entry, index] as const,
  ))
    now.set(identity(entry, index), { entry, index });
  for (const [id, { entry, index }] of now) {
    const old = was.get(id);
    if (old === undefined) rows.push({ area, change: "Added", item: itemName(entry, index) });
    else if (canonicalJson(old.entry) !== canonicalJson(entry))
      rows.push({ area, change: "Changed", item: itemName(entry, index) });
    if (old === undefined) continue;
    const before = asRecord(old.entry);
    const after = asRecord(entry);
    if (before === undefined || after === undefined) continue;
    for (const childKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const childFrom = before[childKey];
      const childTo = after[childKey];
      if (canonicalJson(childFrom ?? null) === canonicalJson(childTo ?? null)) continue;
      if (isCollection(childKey, childFrom) || isCollection(childKey, childTo))
        collectionChanges(childKey, childFrom, childTo, rows);
      else if (childKey !== "id" && childKey !== "key" && childKey !== "name")
        rows.push({ area, change: "Changed", item: itemName(entry, index) });
    }
  }
  for (const [id, { entry, index }] of was)
    if (!now.has(id)) rows.push({ area, change: "Removed", item: itemName(entry, index) });
  // A reorder keeps every entry and changes only their order.
  if (!rows.some((row) => row.area === area)) rows.push({ area, change: "Changed", item: "Order" });
};

/** What replacing one source with another would change, by area and item name, without showing any source. */
export const summarizeSourceChange = (
  current: ApplicationSourceDocument,
  next: ApplicationSourceDocument,
): readonly SourceChangeRow[] => {
  const rows: SourceChangeRow[] = [];
  const before = current.body as unknown as Record<string, unknown>;
  const after = next.body as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key];
    const to = after[key];
    if (canonicalJson(from ?? null) === canonicalJson(to ?? null)) continue;
    if (isCollection(key, from) || isCollection(key, to)) {
      collectionChanges(key, from, to, rows);
      continue;
    }
    const area = areaLabel(key);
    if (from === undefined) rows.push({ area, change: "Added", item: area });
    else if (to === undefined) rows.push({ area, change: "Removed", item: area });
    else rows.push({ area, change: "Changed", item: typeof to === "string" ? to : area });
  }
  return rows;
};
