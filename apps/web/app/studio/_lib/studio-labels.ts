import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import {
  projectStudioSemanticOutline,
  studioSemanticSelectionKey,
  type StudioCompositionContext,
  type StudioPlacementDescriber,
  type StudioSemanticOutlineNode,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";

/** The words a builder sees for each kind of item; aliases and internal kind names never appear. */
export const studioKindLabel = (
  kind: StudioSemanticSelection["kind"] | "section" | "guided_step" | "slot",
): string => {
  switch (kind) {
    case "application":
      return "Application";
    case "page":
      return "Page";
    case "shell":
      return "Layout";
    case "navigation":
      return "Menu entry";
    case "flow":
      return "Flow";
    case "flow_step":
      return "Flow step";
    case "placement":
      return "Item";
    case "section":
      return "Group";
    case "guided_step":
      return "Step";
    case "slot":
      return "Area";
    case "module":
      return "Module";
    case "record_type":
      return "Record type";
    case "field":
      return "Field";
    case "query":
      return "Query";
    case "role":
      return "Role";
  }
};

type Release = ImmutablePlatformBlockCatalogue["releases"][number];

// Authored settings are plain values: a text or choice setting is its string.
const textValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** The item's accessible name, derived field label, or first text setting. */
const itemLabel = (
  release: Release | undefined,
  settings: Readonly<Record<string, unknown>>,
  fieldLabels: ReadonlyMap<string, string>,
): string | undefined => {
  const capabilities = release?.capabilities as
    { accessibleNamePropertyPath?: readonly string[] } | undefined;
  const named = capabilities?.accessibleNamePropertyPath?.[0];
  const namedKind = release?.properties.find((property) => property.key === named)?.kind;
  if (named !== undefined && (namedKind === "text" || namedKind === "choice")) {
    const label = textValue(settings[named]);
    if (label !== undefined) return label;
  }
  for (const property of release?.properties ?? []) {
    if (property.kind !== "field_reference" || !property.derivesFieldInput) continue;
    const reference = textValue(settings[property.key]);
    const label = reference === undefined ? undefined : fieldLabels.get(reference);
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
  source: ApplicationSourceDocument,
): StudioPlacementDescriber => {
  const fieldLabels = new Map(
    source.body.modules.flatMap((module) =>
      module.record_types.flatMap((record) =>
        record.fields.map(
          (field) => [`${module.key}:${record.key}.${field.key}`, field.label] as const,
        ),
      ),
    ),
  );
  return (placement) => {
    const release = catalogue.releases.find(
      (candidate) =>
        String(candidate.blockId) === placement.block.block_id &&
        String(candidate.releaseVersion) === placement.block.release_version,
    );
    const name = release?.name === undefined ? "Item" : String(release.name);
    const label = itemLabel(release, placement.settings, fieldLabels);
    return label === undefined ? name : `${name}: ${label}`;
  };
};

/** Selection key to business label for every item in the outline. */
export const studioOutlineLabels = (
  node: StudioSemanticOutlineNode,
  into = new Map<string, string>(),
): Map<string, string> => {
  if (node.selection !== null) into.set(studioSemanticSelectionKey(node.selection), node.label);
  for (const child of node.children) studioOutlineLabels(child, into);
  return into;
};

/** The business label of every placed item by its authored name, for editors that list or name sibling items. */
export const studioPlacementLabels = (
  context: StudioCompositionContext,
): ReadonlyMap<string, string> => {
  const source = applicationSourceDocumentSchema.parse(context.source);
  const labels = studioOutlineLabels(
    projectStudioSemanticOutline(
      { rootId: context.rootId, source, catalogue: context.catalogue },
      createStudioPlacementDescriber(context.catalogue, source),
    ),
  );
  const byAlias = new Map<string, string>();
  for (const [key, label] of labels)
    if (key.startsWith("placement:")) byAlias.set(key.slice("placement:".length), label);
  return byAlias;
};
