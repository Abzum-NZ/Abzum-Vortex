import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  platformBlockReleaseIdentityV2,
  projectPlatformCatalogueDiscoveryV2,
  type BlockPaletteGroup,
  type BlockPropertySchemaV2Contract,
  type BlockReferencePropertyKindV2,
  type ComponentDiscoveryV2,
  type ComponentPropertyControlV2,
  type ComponentSemanticEventKind,
  type ComponentStateOperationKind,
  type ImmutablePlatformBlockCatalogueV2,
  type PlatformBlockReleaseSummaryV2,
  type PlatformCatalogueDiscoveryV2,
} from "@vortex/contracts";

/**
 * Studio discovery: inspector choices for a selected component, projected from the same
 * server-owned platform block catalogue that save and publish validation use. Studio keeps no
 * allowlist of its own; it only narrows catalogue choices to the application draft being edited
 * and to the page surface. The context lists come from the authoring workspace's server read of
 * that draft and grant nothing; validation remains the authority on save and publish.
 */

type ThemeTokenKind = Extract<BlockPropertySchemaV2Contract, { kind: "theme_token" }>["tokenKind"];

export type StudioReferenceOption = Readonly<{ id: string; key: string; label: string }>;

export type StudioThemeTokenOption = Readonly<{
  tokenKey: string;
  tokenKind: ThemeTokenKind;
  label: string;
}>;

/** Reference targets and theme tokens of the application draft being edited. */
export type StudioDiscoveryContext = Readonly<{
  /** `type` is the page type; a public page may link only to other public pages. */
  pages?: readonly Readonly<{ pageId: string; key: string; name: string; type: string }>[];
  queries?: readonly Readonly<{ queryId: string; key: string; name: string }>[];
  actions?: readonly Readonly<{ actionKey: string; name: string }>[];
  recordTypes?: readonly Readonly<{ recordTypeId: string; key: string; name: string }>[];
  fields?: readonly Readonly<{
    fieldId: string;
    recordTypeId: string;
    key: string;
    name: string;
  }>[];
  relationships?: readonly Readonly<{
    relationshipId: string;
    recordTypeId: string;
    key: string;
    name: string;
  }>[];
  pipelines?: readonly Readonly<{ pipelineId: string; key: string; name: string }>[];
  assets?: readonly Readonly<{ assetId: string; name: string }>[];
  themeTokens?: readonly StudioThemeTokenOption[];
}>;

/** The surface of the page being edited. Shells are always validated as authenticated. */
export type StudioPageSurface =
  | Readonly<{ kind: "authenticated" }>
  | Readonly<{
      kind: "public";
      /** Fields the page declares for public display; validation refuses every other field. */
      publicFieldIds: readonly string[];
      /** The page's public action, the only action a public placement may name. */
      publicActionKey?: string;
      /** Queries the server judged safe for this public page. */
      publicQueryIds: readonly string[];
    }>;

/** Where a new placement would go. */
export type StudioPlacementTarget =
  /** Page main content, or guided-form step content, in the default shell. */
  | Readonly<{ kind: "page" }>
  /** The top level of an application shell layout, which admits only layout components. */
  | Readonly<{ kind: "shell_layout" }>
  /** Page content in an application shell's exposed content slot. */
  | Readonly<{ kind: "shell_content"; allowedChildCategories: readonly BlockPaletteGroup[] }>
  /** A declared slot of an existing placement. */
  | Readonly<{
      kind: "slot";
      parent: Readonly<{ blockId: string; releaseVersion: string }>;
      slotKey: string;
    }>;

export type InspectorPropertyChoice = Readonly<{
  control: ComponentPropertyControlV2;
  /**
   * Targets the author may choose for a reference property. Absent for a record reference: a
   * record is runtime data found through a governed record search, not a draft definition.
   */
  referenceChoices?: readonly StudioReferenceOption[];
  /** Tokens of the declared kind for a theme-token property. */
  themeTokenChoices?: readonly StudioThemeTokenOption[];
  /** Choices for the properties of a group. */
  properties?: readonly InspectorPropertyChoice[];
  /** Choice for each item of a list. */
  item?: InspectorPropertyChoice;
}>;

export type ComponentInspectorChoices = Readonly<{
  component: ComponentDiscoveryV2;
  /** Only properties validation can accept on this surface. */
  properties: readonly InspectorPropertyChoice[];
}>;

export interface StudioDiscoveryAdapter {
  readonly surface: StudioPageSurface;
  readonly context: StudioDiscoveryContext;
  readonly projection: PlatformCatalogueDiscoveryV2;
  /** Every component offered on this surface, in catalogue order. */
  getComponents(): readonly ComponentDiscoveryV2[];
  /** The exact release a placement names, when it is offered on this surface. */
  getComponent(
    block: Readonly<{ blockId: string; releaseVersion: string }>,
  ): ComponentDiscoveryV2 | undefined;
  /**
   * Semantic events the catalogue declares for one placed release; a flow binding to any other
   * event is refused. Empty when the release is not offered on this surface.
   */
  getSupportedEvents(
    block: Readonly<{ blockId: string; releaseVersion: string }>,
  ): readonly ComponentSemanticEventKind[];
  /** State operations the catalogue declares for one placed release. */
  getSupportedStateOperations(
    block: Readonly<{ blockId: string; releaseVersion: string }>,
  ): readonly ComponentStateOperationKind[];
  /** Exact releases that validation admits at a placement target. */
  getPlacementChoices(target: StudioPlacementTarget): readonly PlatformBlockReleaseSummaryV2[];
  /** Inspector choices for one placed release; `recordTypeId` narrows fields and relationships. */
  getInspectorChoices(
    block: Readonly<{ blockId: string; releaseVersion: string }>,
    options?: Readonly<{ recordTypeId?: string }>,
  ): ComponentInspectorChoices | undefined;
  /** Draft targets offered for one reference kind on this surface. */
  getReferenceChoices(
    kind: Exclude<BlockReferencePropertyKindV2, "record_reference">,
    options?: Readonly<{ recordTypeId?: string }>,
  ): readonly StudioReferenceOption[];
  withContext(context: StudioDiscoveryContext): StudioDiscoveryAdapter;
}

/**
 * Reference kinds the public-surface rule (`vortex.definition.application_public_surface`)
 * refuses in every public placement, whatever the draft contains.
 */
const publicRefusedReferenceKinds: ReadonlySet<BlockReferencePropertyKindV2> = new Set<
  BlockReferencePropertyKindV2
>([
  "relationship_reference",
  "record_reference",
  "pipeline_reference",
]);

const option = (id: string, key: string, name: string): StudioReferenceOption =>
  Object.freeze({ id, key, label: name.length > 0 ? name : key });

/** Creates discovery over the server-owned catalogue for one page surface and draft context. */
export function createStudioDiscoveryAdapter(
  options: Readonly<{
    catalogue?: ImmutablePlatformBlockCatalogueV2;
    surface?: StudioPageSurface;
    context?: StudioDiscoveryContext;
  }> = {},
): StudioDiscoveryAdapter {
  const catalogue = options.catalogue ?? IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2;
  const surface: StudioPageSurface = options.surface ?? Object.freeze({ kind: "authenticated" });
  const context: StudioDiscoveryContext = Object.freeze({ ...options.context });
  const isPublic = surface.kind === "public";
  const projection = projectPlatformCatalogueDiscoveryV2(catalogue, surface.kind);

  const getReferenceChoices = (
    kind: Exclude<BlockReferencePropertyKindV2, "record_reference">,
    referenceOptions: Readonly<{ recordTypeId?: string }> = {},
  ): readonly StudioReferenceOption[] => {
    if (publicRefusedReferenceKinds.has(kind) && isPublic) return Object.freeze([]);
    const recordTypeId = referenceOptions.recordTypeId;
    const choices: StudioReferenceOption[] = [];
    switch (kind) {
      case "page_reference":
        for (const page of context.pages ?? [])
          if (!isPublic || page.type === "public")
            choices.push(option(page.pageId, page.key, page.name));
        break;
      case "query_reference":
        for (const query of context.queries ?? [])
          if (surface.kind !== "public" || surface.publicQueryIds.includes(query.queryId))
            choices.push(option(query.queryId, query.key, query.name));
        break;
      case "action_reference":
        for (const action of context.actions ?? [])
          if (surface.kind !== "public" || surface.publicActionKey === action.actionKey)
            choices.push(option(action.actionKey, action.actionKey, action.name));
        break;
      case "record_type_reference":
        for (const recordType of context.recordTypes ?? [])
          choices.push(option(recordType.recordTypeId, recordType.key, recordType.name));
        break;
      case "field_reference":
        for (const field of context.fields ?? [])
          if (
            (recordTypeId === undefined || field.recordTypeId === recordTypeId) &&
            (surface.kind !== "public" || surface.publicFieldIds.includes(field.fieldId))
          )
            choices.push(option(field.fieldId, field.key, field.name));
        break;
      case "relationship_reference":
        for (const relationship of context.relationships ?? [])
          if (recordTypeId === undefined || relationship.recordTypeId === recordTypeId)
            choices.push(option(relationship.relationshipId, relationship.key, relationship.name));
        break;
      case "pipeline_reference":
        for (const pipeline of context.pipelines ?? [])
          choices.push(option(pipeline.pipelineId, pipeline.key, pipeline.name));
        break;
      case "asset_reference":
        for (const asset of context.assets ?? [])
          choices.push(option(asset.assetId, asset.assetId, asset.name));
        break;
    }
    return Object.freeze(choices);
  };

  /**
   * Surface-filtered property choices, or undefined when validation would refuse every value:
   * a public placement drops properties of always-refused reference kinds, and a component or
   * group that needs one of those values cannot be offered at all.
   */
  const propertyChoices = (
    controls: readonly ComponentPropertyControlV2[],
    recordTypeId: string | undefined,
  ): readonly InspectorPropertyChoice[] | undefined => {
    const choices: InspectorPropertyChoice[] = [];
    for (const control of controls) {
      const choice = propertyChoice(control, recordTypeId);
      if (choice !== undefined) choices.push(choice);
      else if (control.valueRequired) return undefined;
    }
    return Object.freeze(choices);
  };

  const propertyChoice = (
    control: ComponentPropertyControlV2,
    recordTypeId: string | undefined,
  ): InspectorPropertyChoice | undefined => {
    const kind = control.referenceKind;
    if (kind !== undefined && isPublic && publicRefusedReferenceKinds.has(kind)) return undefined;
    const declaration = control.declaration;
    const properties =
      control.properties === undefined
        ? undefined
        : propertyChoices(control.properties, recordTypeId);
    const item =
      control.item === undefined ? undefined : propertyChoice(control.item, recordTypeId);
    if (
      (control.properties !== undefined && properties === undefined) ||
      (control.item !== undefined && item === undefined)
    )
      return undefined;
    return Object.freeze({
      control,
      ...(kind !== undefined && kind !== "record_reference"
        ? {
            referenceChoices: getReferenceChoices(
              kind,
              recordTypeId === undefined ? {} : { recordTypeId },
            ),
          }
        : {}),
      ...(declaration.kind === "theme_token"
        ? {
            themeTokenChoices: Object.freeze(
              (context.themeTokens ?? []).filter(
                (token) => token.tokenKind === declaration.tokenKind,
              ),
            ),
          }
        : {}),
      ...(properties === undefined ? {} : { properties }),
      ...(item === undefined ? {} : { item }),
    });
  };

  /** Components validation can accept on this surface, keyed by exact release identity. */
  const offered = new Map<string, ComponentDiscoveryV2>();
  for (const component of projection.components)
    if (propertyChoices(component.properties, undefined) !== undefined)
      offered.set(platformBlockReleaseIdentityV2(component.release), component);
  const components = Object.freeze([...offered.values()]);
  const summaries = components.map((component) => component.release);

  const getComponent = (
    block: Readonly<{ blockId: string; releaseVersion: string }>,
  ): ComponentDiscoveryV2 | undefined => offered.get(platformBlockReleaseIdentityV2(block));

  const getSupportedEvents = (
    block: Readonly<{ blockId: string; releaseVersion: string }>,
  ): readonly ComponentSemanticEventKind[] => getComponent(block)?.supportedEvents ?? [];

  const getSupportedStateOperations = (
    block: Readonly<{ blockId: string; releaseVersion: string }>,
  ): readonly ComponentStateOperationKind[] => getComponent(block)?.supportedStateOperations ?? [];

  const getPlacementChoices = (
    target: StudioPlacementTarget,
  ): readonly PlatformBlockReleaseSummaryV2[] => {
    switch (target.kind) {
      case "page":
        return Object.freeze(summaries);
      case "shell_layout":
        return Object.freeze(summaries.filter((release) => release.paletteGroup === "layout"));
      case "shell_content": {
        const categories = new Set<BlockPaletteGroup>(target.allowedChildCategories);
        return Object.freeze(summaries.filter((release) => categories.has(release.paletteGroup)));
      }
      case "slot": {
        const slot = getComponent(target.parent)?.slots.find(
          (entry) => entry.key === target.slotKey,
        );
        return Object.freeze(
          (slot?.allowedChildren ?? []).filter((release) =>
            offered.has(platformBlockReleaseIdentityV2(release)),
          ),
        );
      }
    }
  };

  const getInspectorChoices = (
    block: Readonly<{ blockId: string; releaseVersion: string }>,
    choiceOptions: Readonly<{ recordTypeId?: string }> = {},
  ): ComponentInspectorChoices | undefined => {
    const component = getComponent(block);
    if (component === undefined) return undefined;
    const properties = propertyChoices(component.properties, choiceOptions.recordTypeId);
    return properties === undefined ? undefined : Object.freeze({ component, properties });
  };

  return Object.freeze({
    surface,
    context,
    projection,
    getComponents: () => components,
    getComponent,
    getSupportedEvents,
    getSupportedStateOperations,
    getPlacementChoices,
    getInspectorChoices,
    getReferenceChoices,
    withContext: (updated: StudioDiscoveryContext) =>
      createStudioDiscoveryAdapter({ catalogue, surface, context: { ...context, ...updated } }),
  });
}
