import type {
  ApplicationSourceDocument,
  ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import type { StudioPlacementDescriber } from "./semantic-outline";

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
  // A block that declares its accessible name is never named by another text (an empty message).
  if (named !== undefined) return undefined;
  for (const property of release?.properties ?? []) {
    const label = textValue(settings[property.key as string]);
    if (property.kind === "text" && label !== undefined) return label;
  }
  return undefined;
};

/** "Button · New company": the block's display name from its release, then the item's label. */
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
    return label === undefined ? name : `${name} · ${label}`;
  };
};
