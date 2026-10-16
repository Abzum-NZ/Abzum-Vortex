import { applicationSourceDocumentSchema, type ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import {
  projectStudioSemanticOutline, studioSemanticSelectionKey,
  type StudioCompositionContext, type StudioPlacementDescriber, type StudioSemanticOutlineNode, type StudioSemanticSelection,
} from "@vortex/ui/studio";

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

// Authored settings are plain values: a text or choice setting is its string.
const textValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** The setting that names an item to a person: the block's accessible-name setting, else its first text setting. */
const itemLabel = (release: Release | undefined, settings: Readonly<Record<string, unknown>>): string | undefined => {
  const capabilities = release?.capabilities as { accessibleNamePropertyPath?: readonly string[] } | undefined;
  const named = capabilities?.accessibleNamePropertyPath?.[0];
  const namedKind = release?.properties.find((property) => property.key === named)?.kind;
  if (named !== undefined && (namedKind === "text" || namedKind === "choice")) {
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

/** Selection key to business label for every item in the outline. */
export const studioOutlineLabels = (node: StudioSemanticOutlineNode, into = new Map<string, string>()): Map<string, string> => {
  if (node.selection !== null) into.set(studioSemanticSelectionKey(node.selection), node.label);
  for (const child of node.children) studioOutlineLabels(child, into);
  return into;
};

/** The business label of every placed item by its authored name, for editors that list or name sibling items. */
export const studioPlacementLabels = (context: StudioCompositionContext): ReadonlyMap<string, string> => {
  const labels = studioOutlineLabels(projectStudioSemanticOutline(
    { rootId: context.rootId, source: applicationSourceDocumentSchema.parse(context.source) },
    createStudioPlacementDescriber(context.catalogue)));
  const byAlias = new Map<string, string>();
  for (const [key, label] of labels) if (key.startsWith("placement:")) byAlias.set(key.slice("placement:".length), label);
  return byAlias;
};

const sentence = (key: string): string => {
  const words = key.trim().replace(/[-_.]+/g, " ").replace(/\s+/g, " ");
  return words === "" ? key : words[0]!.toUpperCase() + words.slice(1);
};

/** A theme setting's key as a name a person reads ("primary_foreground" becomes "Primary foreground"). */
export const tokenName = sentence;

/** The kind of a theme setting in plain words. */
export const tokenKindName = (kind: string): string => {
  switch (kind) {
    case "color_pair": return "colour";
    case "typography": return "text style";
    case "border": return "border";
    case "focus": return "focus outline";
    case "asset": return "image";
    case "shadow": return "shadow";
    case "radius": return "corner radius";
    default: return kind.replaceAll("_", " ");
  }
};
