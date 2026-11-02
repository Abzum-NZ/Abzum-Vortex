import { asRecord } from "../catalogue/runtime-primitives";
import { canonicalJson } from "./canonical-json";
import type { ApplicationSourceDocument } from "./application-source-contracts";

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
  const start = rows.length;
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
      // The entry itself was recorded as changed above; only its own collections are looked into.
      if (isCollection(childKey, childFrom) || isCollection(childKey, childTo))
        collectionChanges(childKey, childFrom, childTo, rows);
    }
    if (key === "pages") blockChanges(old.entry, entry, rows);
  }
  for (const [id, { entry, index }] of was)
    if (!now.has(id)) rows.push({ area, change: "Removed", item: itemName(entry, index) });
  // A reorder keeps every entry and changes only their order.
  if (rows.length === start) rows.push({ area, change: "Changed", item: "Order" });
};

/** Every block of a page's composition, by the id its settings carry: an object with a type and settings that hold an id. */
const blocksOf = (page: unknown): ReadonlyMap<string, Readonly<Record<string, unknown>>> => {
  const blocks = new Map<string, Readonly<Record<string, unknown>>>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const member of value) visit(member);
      return;
    }
    const fields = asRecord(value);
    if (fields === undefined) return;
    const props = asRecord(fields.props);
    if (typeof fields.type === "string" && props !== undefined && typeof props.id === "string")
      blocks.set(props.id, fields);
    for (const member of Object.values(fields)) visit(member);
  };
  visit(asRecord(page)?.composition);
  return blocks;
};

/** The blocks a page that stayed gained, lost or changed, so a block edit counts as one block and not only as a changed page. */
const blockChanges = (from: unknown, to: unknown, rows: SourceChangeRow[]): void => {
  const was = blocksOf(from);
  const now = blocksOf(to);
  const label = (block: Readonly<Record<string, unknown>>): string => {
    const props = asRecord(block.props);
    for (const field of ["title", "label", "name"]) {
      const value = props?.[field];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    // The block's type as words: "platform.renderer.text" reads "Text".
    const type = String(block.type).split(".").at(-1) ?? "block";
    return type.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
  };
  for (const [id, block] of now) {
    const old = was.get(id);
    if (old === undefined) rows.push({ area: "Blocks", change: "Added", item: label(block) });
    else if (canonicalJson(old.props) !== canonicalJson(block.props))
      rows.push({ area: "Blocks", change: "Changed", item: label(block) });
  }
  for (const [id, block] of was)
    if (!now.has(id)) rows.push({ area: "Blocks", change: "Removed", item: label(block) });
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

/** How many items of one area a release added, changed and removed. */
export type SourceChangeCount = Readonly<{
  area: string;
  added: number;
  changed: number;
  removed: number;
}>;

/** The areas a release summary names (design 9.2); every other area of the source counts as `other`. */
export const releaseSummaryAreas = [
  "pages",
  "blocks",
  "fields",
  "flows",
  "roles",
  "other",
] as const;
export type ReleaseSummaryArea = (typeof releaseSummaryAreas)[number];

const summaryAreaOf: Readonly<Record<string, ReleaseSummaryArea>> = {
  Pages: "pages",
  Blocks: "blocks",
  Fields: "fields",
  Flows: "flows",
  "Access groups": "roles",
  Permissions: "roles",
};

/** Items changed (added, changed or removed) in each summary area, from the counts by source area. */
export const summarizeChangeAreas = (
  counts: readonly SourceChangeCount[],
): Readonly<Record<ReleaseSummaryArea, number>> => {
  const totals: Record<ReleaseSummaryArea, number> = {
    pages: 0,
    blocks: 0,
    fields: 0,
    flows: 0,
    roles: 0,
    other: 0,
  };
  for (const count of counts)
    totals[summaryAreaOf[count.area] ?? "other"] += count.added + count.changed + count.removed;
  return totals;
};

const summaryNouns: Readonly<Record<ReleaseSummaryArea, readonly [string, string]>> = {
  pages: ["page", "pages"],
  blocks: ["block", "blocks"],
  fields: ["field", "fields"],
  flows: ["flow", "flows"],
  roles: ["role", "roles"],
  other: ["other item", "other items"],
};

/**
 * "3 pages, 2 blocks, 1 flow changed": the one sentence for what a version changed, used by the
 * version history and the publish confirmation so both count the same way. Undefined when nothing
 * changed.
 */
export const describeSourceChange = (counts: readonly SourceChangeCount[]): string | undefined => {
  const totals = summarizeChangeAreas(counts);
  const shown = releaseSummaryAreas
    .filter((area) => totals[area] > 0)
    .map((area) => `${totals[area]} ${summaryNouns[area][totals[area] === 1 ? 0 : 1]}`);
  return shown.length === 0 ? undefined : `${shown.join(", ")} changed`;
};

/** The rows of a source change counted by area, in the order the areas first appear. */
export const countSourceChange = (
  rows: readonly SourceChangeRow[],
): readonly SourceChangeCount[] => {
  const counts = new Map<string, { added: number; changed: number; removed: number }>();
  for (const row of rows) {
    const count = counts.get(row.area) ?? { added: 0, changed: 0, removed: 0 };
    if (row.change === "Added") count.added += 1;
    else if (row.change === "Removed") count.removed += 1;
    else count.changed += 1;
    counts.set(row.area, count);
  }
  return [...counts].map(([area, count]) => ({ area, ...count }));
};
