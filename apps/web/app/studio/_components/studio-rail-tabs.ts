import type { StudioRailTab } from "./studio-frame";

/** Studio's rail: one tab per area of an application, in the order a builder works through them. */
export type StudioRailKey =
  "structure" | "outline" | "blocks" | "menu" | "data" | "flows" | "theme" | "access" | "releases";

export const studioRailTabs: readonly StudioRailTab<StudioRailKey>[] = [
  { key: "structure", label: "Structure", icon: "sitemap", group: "build" },
  { key: "outline", label: "Outline", icon: "list-tree", group: "build" },
  { key: "blocks", label: "Blocks", icon: "blocks", group: "build" },
  { key: "menu", label: "Menu", icon: "menu", group: "build" },
  { key: "data", label: "Data", icon: "database", group: "logic" },
  { key: "flows", label: "Flows", icon: "workflow", group: "logic" },
  { key: "theme", label: "Theme", icon: "palette", group: "look" },
  { key: "access", label: "Access", icon: "shield", group: "look" },
  { key: "releases", label: "Releases", icon: "history", group: "releases" },
];

export const isStudioRailKey = (value: unknown): value is StudioRailKey =>
  studioRailTabs.some((tab) => tab.key === value);

/** The tabs whose centre is the page canvas; Data, Flows, Access and Releases draw their own editor there. */
export const railShowsCanvas = (key: StudioRailKey): boolean =>
  key !== "data" && key !== "flows" && key !== "access" && key !== "releases";

/** What the Releases tab can open in the centre. */
export type StudioReleasesSection = "history" | "backend-runs" | "page-adoption" | "import";
export const studioReleasesSections: readonly Readonly<{
  value: StudioReleasesSection;
  label: string;
  description: string;
}>[] = [
  {
    value: "history",
    label: "Published versions",
    description:
      "Every published version: when, by whom and what changed. Restore one into the draft.",
  },
  {
    value: "backend-runs",
    label: "Back-end runs",
    description: "The newest runs on the back end: flow, origin, state, failure reason and times.",
  },
  {
    value: "page-adoption",
    label: "Page adoption",
    description: "Keep your own page or adopt the standard one after an upgrade.",
  },
  {
    value: "import",
    label: "Import from source",
    description: "Advanced: replace the draft with a source document.",
  },
];
export const isStudioReleasesSection = (value: unknown): value is StudioReleasesSection =>
  studioReleasesSections.some((section) => section.value === value);
