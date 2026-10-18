import type { StudioRailTab } from "./studio-frame";

/** Studio's rail: one tab per area of an application, in the order a builder works through them. */
export type StudioRailKey =
  | "structure" | "outline" | "blocks" | "menu" | "data" | "flows" | "theme" | "access" | "releases";

export const studioRailTabs: readonly StudioRailTab<StudioRailKey>[] = [
  { key: "structure", label: "Structure", icon: "sitemap", width: 17, group: "build" },
  { key: "outline", label: "Outline", icon: "list-tree", width: 17, group: "build" },
  { key: "blocks", label: "Blocks", icon: "blocks", width: 18, group: "build" },
  { key: "menu", label: "Menu", icon: "menu", width: 20, group: "build" },
  { key: "data", label: "Data", icon: "database", width: 18, group: "logic" },
  { key: "flows", label: "Flows", icon: "workflow", width: 17, group: "logic" },
  { key: "theme", label: "Theme", icon: "palette", width: 22, group: "look" },
  { key: "access", label: "Access", icon: "shield", width: 17, group: "look" },
  { key: "releases", label: "Releases", icon: "history", width: 17, group: "releases" },
];

export const isStudioRailKey = (value: unknown): value is StudioRailKey =>
  studioRailTabs.some((tab) => tab.key === value);

/** The tabs whose centre is the page canvas; Data, Flows, Access and Releases draw their own editor there. */
export const railShowsCanvas = (key: StudioRailKey): boolean =>
  key !== "data" && key !== "flows" && key !== "access" && key !== "releases";

/** What the Releases tab can open in the centre. */
export type StudioReleasesSection = "history" | "page-adoption" | "import";
export const studioReleasesSections: readonly Readonly<{ value: StudioReleasesSection; label: string; description: string }>[] = [
  { value: "history", label: "Published versions", description: "Every published version: when, by whom and what changed. Restore one into the draft." },
  { value: "page-adoption", label: "Page adoption", description: "Keep your own page or adopt the standard one after an upgrade." },
  { value: "import", label: "Import from source", description: "Advanced: replace the draft with a source document." },
];
export const isStudioReleasesSection = (value: unknown): value is StudioReleasesSection =>
  studioReleasesSections.some((section) => section.value === value);
