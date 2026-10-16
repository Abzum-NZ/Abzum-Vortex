import { canonicalJson, type ApplicationSourceDocument } from "@vortex/platform/schema";

export type SourceChangeRow = Readonly<{ area: string; change: "Added" | "Removed" | "Changed"; item: string }>;

/** The areas of an application a builder knows by name; any other area is named from its key. */
const areaLabels: Readonly<Record<string, string>> = {
  name: "Name", description: "Description", icon: "Icon", home_page: "Home page", search: "Search",
  modules: "Modules", uses: "Modules used", permissions: "Permissions", roles: "Access groups", navigation: "Menu",
  shells: "Layouts", pages: "Pages", flows: "Flows", theme: "Appearance", actions: "Actions",
  platform_block_dependencies: "Item types used", connections: "Connections",
};
const areaLabel = (key: string): string => areaLabels[key] ??
  (key.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase()));

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The name a person knows an entry by, from its own name or label; a key is the last resort. */
const itemName = (entry: unknown, index: number): string => {
  const fields = record(entry);
  for (const field of ["name", "label", "key", "purpose", "module", "id"]) {
    const value = fields?.[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return `Entry ${index + 1}`;
};
const identity = (entry: unknown, index: number): string => {
  const fields = record(entry);
  for (const field of ["id", "key", "module", "purpose"]) {
    const value = fields?.[field];
    if (typeof value === "string") return value;
  }
  return `#${index}`;
};

/** What replacing one source with another would change, by area and item name, without showing any source. */
export const summarizeSourceChange = (
  current: ApplicationSourceDocument, next: ApplicationSourceDocument,
): readonly SourceChangeRow[] => {
  const rows: SourceChangeRow[] = [];
  const before = current.body as unknown as Record<string, unknown>;
  const after = next.body as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key];
    const to = after[key];
    if (canonicalJson(from ?? null) === canonicalJson(to ?? null)) continue;
    const area = areaLabel(key);
    if (Array.isArray(from) || Array.isArray(to)) {
      const was = new Map((Array.isArray(from) ? from : []).map((entry, index) => [identity(entry, index), { entry, index }]));
      const now = new Map((Array.isArray(to) ? to : []).map((entry, index) => [identity(entry, index), { entry, index }]));
      for (const [id, { entry, index }] of now) {
        const old = was.get(id);
        if (old === undefined) rows.push({ area, change: "Added", item: itemName(entry, index) });
        else if (canonicalJson(old.entry) !== canonicalJson(entry)) rows.push({ area, change: "Changed", item: itemName(entry, index) });
      }
      for (const [id, { entry, index }] of was)
        if (!now.has(id)) rows.push({ area, change: "Removed", item: itemName(entry, index) });
      // A reorder keeps every entry and changes only their order.
      if (!rows.some((row) => row.area === area))
        rows.push({ area, change: "Changed", item: "Order" });
    } else if (from === undefined) rows.push({ area, change: "Added", item: area });
    else if (to === undefined) rows.push({ area, change: "Removed", item: area });
    else rows.push({ area, change: "Changed", item: typeof to === "string" ? to : area });
  }
  return rows;
};
