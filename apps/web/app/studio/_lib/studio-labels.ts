import type { ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import type { StudioPlacementDescriber, StudioSemanticSelection } from "@vortex/ui/studio";

/** The words a builder sees for each kind of item; aliases and internal kind names never appear. */
export const studioKindLabel = (kind: StudioSemanticSelection["kind"] | "section" | "guided_step" | "slot"): string => {
  switch (kind) {
    case "application": return "Application";
    case "page": return "Page";
    case "shell": return "Layout";
    case "navigation": return "Menu entry";
    case "flow": return "Flow";
    case "placement": return "Item";
    case "section": return "Group";
    case "guided_step": return "Step";
    case "slot": return "Area";
  }
};

type Release = ImmutablePlatformBlockCatalogue["releases"][number];

const textValue = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as { kind?: unknown; value?: unknown };
  if (entry.kind !== "text" && entry.kind !== "choice") return undefined;
  return typeof entry.value === "string" && entry.value.trim().length > 0 ? entry.value.trim() : undefined;
};

/** The setting that names an item to a person: the block's accessible-name setting, else its first text setting. */
const itemLabel = (release: Release | undefined, settings: Readonly<Record<string, unknown>>): string | undefined => {
  const capabilities = release?.capabilities as { accessibleNamePropertyPath?: readonly string[] } | undefined;
  const named = capabilities?.accessibleNamePropertyPath?.[0];
  if (named !== undefined) {
    const label = textValue(settings[named]);
    if (label !== undefined) return label;
  }
  for (const property of release?.properties ?? []) {
    const label = textValue(settings[property.key as string]);
    if (property.kind === "text" && label !== undefined) return label;
  }
  return undefined;
};

/** "Button: New company": the block's display name from its release, then the item's own label. */
export const createStudioPlacementDescriber = (
  catalogue: ImmutablePlatformBlockCatalogue,
): StudioPlacementDescriber => (placement) => {
  const release = catalogue.releases.find((candidate) =>
    String(candidate.blockId) === placement.block.block_id &&
    String(candidate.releaseVersion) === placement.block.release_version);
  const name = release?.name === undefined ? "Item" : String(release.name);
  const label = itemLabel(release, placement.settings);
  return label === undefined ? name : `${name}: ${label}`;
};
