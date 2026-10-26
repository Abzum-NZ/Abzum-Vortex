import type { BlockPaletteGroup } from "../../catalogue/catalogues";
import type { ComponentSemanticEventKind } from "../component-semantic-events";
import type { BlockPropertySchemaContract } from "./block-property-schema";
import type {
  PlatformBlockRelease,
  ComponentStateOperationKind,
  ApplicationCompositionPolicy,
  ImmutablePlatformBlockCatalogue,
} from "./platform-block-release";

/*
 * Studio discovery projection. It republishes the declarations of one immutable platform block
 * catalogue, the same catalogue save and publish validation judge, so Studio offers only what that
 * catalogue declares and a new catalogue release needs no separate Studio allowlist. The catalogue
 * declares no per-release semantic events yet; the only operations projected are the placement
 * layout operations validation enforces from each release's capabilities.
 */

/** Property kinds whose value names an application-scoped or stored target. */
export const blockReferencePropertyKinds = [
  "total_reference",
  "field_reference",
  "relationship_reference",
  "action_reference",
  "page_reference",
  "query_reference",
  "record_type_reference",
  "record_reference",
  "asset_reference",
] as const satisfies readonly BlockPropertySchemaContract["kind"][];
export type BlockReferencePropertyKind = (typeof blockReferencePropertyKinds)[number];

const blockReferencePropertyKindSet: ReadonlySet<string> = new Set(blockReferencePropertyKinds);

export const isBlockReferencePropertyKind = (
  kind: BlockPropertySchemaContract["kind"],
): kind is BlockReferencePropertyKind => blockReferencePropertyKindSet.has(kind);

/** A public page admits only releases whose capabilities allow the public surface. */
export type CompositionSurface = "authenticated" | "public";

/** Exact release identity and palette metadata; its fingerprints fill a dependency manifest. */
export type PlatformBlockReleaseSummary = Readonly<
  Pick<
    PlatformBlockRelease,
    | "blockId"
    | "key"
    | "releaseVersion"
    | "contentFingerprint"
    | "name"
    | "description"
    | "icon"
    | "paletteGroup"
    | "rendererKey"
  > & { publicSurface: PlatformBlockRelease["capabilities"]["publicSurface"] }
>;

export type ComponentPropertyControl = Readonly<{
  /** The exact catalogue declaration, including every constraint validation applies to it. */
  declaration: BlockPropertySchemaContract;
  /** Validation refuses the placement when the author leaves this value unset. */
  valueRequired: boolean;
  /** This text property supplies the component's accessible name. */
  accessibleName: boolean;
  referenceKind?: BlockReferencePropertyKind;
  /** Controls of a group declaration, in declaration order. */
  properties?: readonly ComponentPropertyControl[];
  /** Control for each item of a list declaration. */
  item?: ComponentPropertyControl;
}>;

/** Placement layout choices; content width, fill width and content height are always available. */
export type ComponentLayoutOperations = Readonly<{
  /** Visibility may differ between desktop, tablet and phone. */
  responsiveVisibility: boolean;
  /** Placements inside this component's slots may use a different order per breakpoint. */
  responsiveChildOrder: boolean;
  /** Width may use a twelve-column grid span. */
  gridWidth: boolean;
  /** Height may be bounded. */
  boundedHeight: boolean;
}>;

export type ComponentDiscoverySlot = Readonly<{
  key: string;
  label: string;
  required: boolean;
  allowedChildCategories: readonly BlockPaletteGroup[];
  /**
   * Present on a repeatable slot: the inspector offers one child slot per item of the list
   * property `items`, each keyed by the item's text property `identity`. Absent on a fixed slot.
   */
  repeats?: Readonly<{ items: string; identity: string }>;
  /** Exact releases validation admits in this slot on the projected surface. */
  allowedChildren: readonly PlatformBlockReleaseSummary[];
}>;

export type ComponentDiscovery = Readonly<{
  release: PlatformBlockReleaseSummary;
  /** Semantic events a flow binding may name for this release, as the catalogue declares them. */
  supportedEvents: readonly ComponentSemanticEventKind[];
  /** State operations a flow may apply to this release, as the catalogue declares them. */
  supportedStateOperations: readonly ComponentStateOperationKind[];
  accessibleName: PlatformBlockRelease["capabilities"]["accessibleName"];
  properties: readonly ComponentPropertyControl[];
  /** Distinct reference kinds declared anywhere in the component's properties. */
  referenceKinds: readonly BlockReferencePropertyKind[];
  slots: readonly ComponentDiscoverySlot[];
  layoutOperations: ComponentLayoutOperations;
}>;

export type PlatformCatalogueDiscovery = Readonly<{
  surface: CompositionSurface;
  compositionPolicy: ApplicationCompositionPolicy;
  /** Every release offered on the surface, in catalogue order. */
  components: readonly ComponentDiscovery[];
  /** Keyed by platformBlockReleaseIdentity, the exact identity a placement names. */
  componentsByRelease: ReadonlyMap<string, ComponentDiscovery>;
}>;

export const platformBlockReleaseIdentity = (
  block: Readonly<{ blockId: string; releaseVersion: string }>,
): string => `${block.blockId}:${block.releaseVersion}`;

const summarisePlatformBlockRelease = (
  release: PlatformBlockRelease,
): PlatformBlockReleaseSummary =>
  Object.freeze({
    blockId: release.blockId,
    key: release.key,
    releaseVersion: release.releaseVersion,
    contentFingerprint: release.contentFingerprint,
    name: release.name,
    description: release.description,
    icon: release.icon,
    paletteGroup: release.paletteGroup,
    rendererKey: release.rendererKey,
    publicSurface: release.capabilities.publicSurface,
  });

/**
 * Mirrors the catalogue validation rules: an unset value is refused when its declaration is
 * required without a default, and a required accessible name must be reachable after defaults
 * along its property path.
 */
const projectPropertyControls = (
  declarations: readonly BlockPropertySchemaContract[],
  namePath: readonly string[] | undefined,
  nameRequired: boolean,
): readonly ComponentPropertyControl[] =>
  Object.freeze(
    declarations.map((declaration): ComponentPropertyControl => {
      const rest =
        namePath !== undefined && namePath[0] === declaration.key ? namePath.slice(1) : undefined;
      const nameValueRequired =
        rest !== undefined && nameRequired && declaration.defaultValue === undefined;
      return Object.freeze({
        declaration,
        valueRequired:
          (declaration.required && declaration.defaultValue === undefined) || nameValueRequired,
        accessibleName: rest !== undefined && rest.length === 0,
        ...(isBlockReferencePropertyKind(declaration.kind)
          ? { referenceKind: declaration.kind }
          : {}),
        ...(declaration.kind === "group"
          ? {
              properties: projectPropertyControls(
                declaration.properties,
                rest !== undefined && rest.length > 0 ? rest : undefined,
                nameValueRequired,
              ),
            }
          : {}),
        ...(declaration.kind === "list"
          ? { item: projectPropertyControls([declaration.item], undefined, false)[0]! }
          : {}),
      });
    }),
  );

const collectReferenceKinds = (
  controls: readonly ComponentPropertyControl[],
  kinds: Set<BlockReferencePropertyKind>,
): Set<BlockReferencePropertyKind> => {
  for (const control of controls) {
    if (control.referenceKind !== undefined) kinds.add(control.referenceKind);
    if (control.properties !== undefined) collectReferenceKinds(control.properties, kinds);
    if (control.item !== undefined) collectReferenceKinds([control.item], kinds);
  }
  return kinds;
};

/** Projects the releases, property controls, slot children and layout operations of one surface. */
export const projectPlatformCatalogueDiscovery = (
  catalogue: ImmutablePlatformBlockCatalogue,
  surface: CompositionSurface = "authenticated",
): PlatformCatalogueDiscovery => {
  const offered = catalogue.releases.filter(
    (release) => surface === "authenticated" || release.capabilities.publicSurface === "allowed",
  );
  const summaries = offered.map(summarisePlatformBlockRelease);
  const components = Object.freeze(
    offered.map((release, index): ComponentDiscovery => {
      const capabilities = release.capabilities;
      const properties = projectPropertyControls(
        release.properties,
        capabilities.accessibleName === "not_applicable"
          ? undefined
          : capabilities.accessibleNamePropertyPath,
        capabilities.accessibleName === "required",
      );
      return Object.freeze({
        release: summaries[index]!,
        supportedEvents: Object.freeze([...release.supportedEvents]),
        supportedStateOperations: Object.freeze([...release.supportedStateOperations]),
        accessibleName: capabilities.accessibleName,
        properties,
        referenceKinds: Object.freeze([...collectReferenceKinds(properties, new Set())]),
        slots: Object.freeze(
          release.slots.map((slot): ComponentDiscoverySlot => {
            const categories = new Set<BlockPaletteGroup>(slot.allowedChildCategories);
            return Object.freeze({
              key: slot.key,
              label: slot.label,
              required: slot.required,
              allowedChildCategories: Object.freeze([...slot.allowedChildCategories]),
              ...(slot.repeats === undefined
                ? {}
                : { repeats: Object.freeze({ ...slot.repeats }) }),
              allowedChildren: Object.freeze(
                summaries.filter((child) => categories.has(child.paletteGroup)),
              ),
            });
          }),
        ),
        layoutOperations: Object.freeze({
          responsiveVisibility: capabilities.responsiveVisibility,
          responsiveChildOrder: capabilities.responsiveOrder,
          gridWidth: capabilities.gridWidth,
          boundedHeight: capabilities.height === "content_or_bounded",
        }),
      });
    }),
  );
  return Object.freeze({
    surface,
    compositionPolicy: catalogue.compositionPolicy,
    components,
    componentsByRelease: new Map(
      components.map((component) => [platformBlockReleaseIdentity(component.release), component]),
    ),
  });
};
