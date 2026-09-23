import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  projectComponentDiscoveryV2,
  projectPlatformCatalogueDiscoveryV2,
  type BlockPaletteGroup,
  type BlockPropertySchemaV2Contract,
  type BlockPropertyValueV2Contract,
  type ComponentDiscoveryProjectionV2,
  type ComponentDiscoverySlotV2,
  type ComponentPropertyControlV2,
  type ComponentReferenceKindV2,
  type ComponentStateOperationCategory,
  type ComponentStateOperationV2,
  type ImmutablePlatformBlockCatalogueV2,
  type PlatformBlockReleaseV2,
  type PlatformCatalogueDiscoveryProjectionV2,
} from "@vortex/contracts";

/**
 * Page, query, action, record and asset options available in current application/module context.
 */
export type StudioPageOption = Readonly<{
  pageId: string;
  key: string;
  name: string;
  routeKey?: string;
  type?: string;
}>;

export type StudioQueryOption = Readonly<{
  queryId: string;
  key: string;
  name: string;
  moduleRootId?: string;
  targetRecordTypeId?: string;
}>;

export type StudioActionOption = Readonly<{
  actionId: string;
  key: string;
  name: string;
  moduleRootId?: string;
  recordTypeId?: string;
  publicSurface?: "allowed" | "refused";
}>;

export type StudioRecordTypeOption = Readonly<{
  recordTypeId: string;
  key: string;
  name: string;
}>;

export type StudioFieldOption = Readonly<{
  fieldId: string;
  recordTypeId: string;
  key: string;
  name: string;
  type: string;
}>;

export type StudioRelationshipOption = Readonly<{
  relationshipId: string;
  recordTypeId: string;
  key: string;
  name: string;
  targetRecordTypeId: string;
}>;

export type StudioPipelineOption = Readonly<{
  pipelineId: string;
  key: string;
  name: string;
}>;

export type StudioAssetOption = Readonly<{
  assetId: string;
  name: string;
  mimeType?: string;
}>;

export type StudioThemeTokenOption = Readonly<{
  tokenKey: string;
  tokenKind: string;
  label?: string;
}>;

/** Contextual constraints passed by the application authoring environment. */
export type StudioDiscoveryContext = Readonly<{
  isPublicPage?: boolean;
  surface?: "public" | "authenticated";
  applicationId?: string;
  pages?: readonly StudioPageOption[];
  queries?: readonly StudioQueryOption[];
  actions?: readonly StudioActionOption[];
  recordTypes?: readonly StudioRecordTypeOption[];
  fields?: readonly StudioFieldOption[];
  relationships?: readonly StudioRelationshipOption[];
  pipelines?: readonly StudioPipelineOption[];
  assets?: readonly StudioAssetOption[];
  themeTokens?: readonly StudioThemeTokenOption[];
}>;

export type InspectorReferenceChoice = Readonly<{
  id: string;
  key: string;
  label: string;
}>;

export type InspectorPropertyChoice = Readonly<{
  key: string;
  label: string;
  help?: string | undefined;
  required: boolean;
  defaultValue?: BlockPropertyValueV2Contract | undefined;
  controlKind: BlockPropertySchemaV2Contract["kind"];
  controlType: string;
  isReference: boolean;
  referenceKind?: ComponentReferenceKindV2 | undefined;
  choiceOptions?: readonly { key: string; label: string }[] | undefined;
  allowedElements?: readonly string[] | undefined;
  themeTokenChoices?: readonly StudioThemeTokenOption[] | undefined;
  referenceChoices?: readonly InspectorReferenceChoice[] | undefined;
  textConstraints?: { minLength: number; maxLength: number } | undefined;
  numberConstraints?:
    | { integer: boolean; minimum?: number | undefined; maximum?: number | undefined }
    | undefined;
  nestedProperties?: readonly InspectorPropertyChoice[] | undefined;
  listItem?: InspectorPropertyChoice | undefined;
  listConstraints?: { minimumItems: number; maximumItems: number } | undefined;
}>;

export type InspectorSlotChoice = Readonly<{
  slotKey: string;
  slotLabel: string;
  required: boolean;
  allowedCategories: readonly BlockPaletteGroup[];
  allowedChildBlocks: readonly {
    blockId: string;
    key: string;
    releaseVersion: string;
    name: string;
    icon: string;
    paletteGroup: BlockPaletteGroup;
  }[];
}>;

export type InspectorOperationChoice = Readonly<{
  key: string;
  label: string;
  description?: string | undefined;
  category: ComponentStateOperationCategory;
}>;

export type ComponentInspectorChoices = Readonly<{
  component: Readonly<{
    blockId: string;
    key: string;
    releaseVersion: string;
    name: string;
    icon: string;
    paletteGroup: BlockPaletteGroup;
    rendererKey: string;
    publicSurface: "allowed" | "refused";
  }>;
  properties: readonly InspectorPropertyChoice[];
  slots: readonly InspectorSlotChoice[];
  operations: readonly InspectorOperationChoice[];
  referenceKinds: readonly ComponentReferenceKindV2[];
}>;

export interface StudioDiscoveryAdapter {
  /** The immutable catalogue backing this discovery adapter. */
  readonly catalogue: ImmutablePlatformBlockCatalogueV2;

  /** Current context filtering discovery and choices. */
  readonly context: StudioDiscoveryContext;

  /** Full discovery projection for the entire catalogue under current context. */
  readonly projection: PlatformCatalogueDiscoveryProjectionV2;

  /** Look up discovery projection for one component by blockId or namespaced key. */
  getComponentDiscovery(blockIdOrKey: string): ComponentDiscoveryProjectionV2 | undefined;

  /** List all available components under the current context (filtered by public surface). */
  getAvailableComponents(): readonly ComponentDiscoveryProjectionV2[];

  /** List available components grouped by palette category. */
  getAvailableComponentsByGroup(): Readonly<Record<string, readonly ComponentDiscoveryProjectionV2[]>>;

  /** Produce comprehensive inspector choices for the selected component. */
  getInspectorChoices(
    blockIdOrKey: string,
    options?: { recordTypeId?: string; slotKey?: string },
  ): ComponentInspectorChoices | undefined;

  /** Get allowed child blocks that can be placed inside a specific slot of a component. */
  getAllowedChildBlocks(
    blockIdOrKey: string,
    slotKey: string,
  ): readonly {
    blockId: string;
    key: string;
    releaseVersion: string;
    name: string;
    icon: string;
    paletteGroup: BlockPaletteGroup;
  }[];

  /** Get valid reference choices for a reference kind in the current application/module context. */
  getReferenceChoices(
    referenceKind: ComponentReferenceKindV2,
    options?: { recordTypeId?: string },
  ): readonly InspectorReferenceChoice[];

  /** Check if a property key is offered by the component's inspector choices. */
  isPropertyOffered(blockIdOrKey: string, propertyKey: string): boolean;

  /** Check if a child block is offered for a specific slot. */
  isChildBlockOffered(
    blockIdOrKey: string,
    slotKey: string,
    childBlockIdOrKey: string,
  ): boolean;

  /** Check if an operation key is offered by the component's inspector choices. */
  isOperationOffered(blockIdOrKey: string, operationKey: string): boolean;

  /** Check if a reference ID or key is offered for a given reference kind. */
  isReferenceOffered(
    referenceKind: ComponentReferenceKindV2,
    referenceIdOrKey: string,
    options?: { recordTypeId?: string },
  ): boolean;

  /** Return a new adapter with updated context. */
  withContext(updatedContext: StudioDiscoveryContext): StudioDiscoveryAdapter;
}

type MutableInspectorPropertyChoice = {
  key: string;
  label: string;
  help?: string | undefined;
  required: boolean;
  defaultValue?: BlockPropertyValueV2Contract | undefined;
  controlKind: BlockPropertySchemaV2Contract["kind"];
  controlType: string;
  isReference: boolean;
  referenceKind?: ComponentReferenceKindV2 | undefined;
  choiceOptions?: readonly { key: string; label: string }[] | undefined;
  allowedElements?: readonly string[] | undefined;
  themeTokenChoices?: readonly StudioThemeTokenOption[] | undefined;
  referenceChoices?: readonly InspectorReferenceChoice[] | undefined;
  textConstraints?: { minLength: number; maxLength: number } | undefined;
  numberConstraints?:
    | { integer: boolean; minimum?: number | undefined; maximum?: number | undefined }
    | undefined;
  nestedProperties?: readonly InspectorPropertyChoice[] | undefined;
  listItem?: InspectorPropertyChoice | undefined;
  listConstraints?: { minimumItems: number; maximumItems: number } | undefined;
};

/**
 * Creates a Studio discovery adapter from the server-owned immutable platform block catalogue.
 * Automatically adapts component releases into inspector choices without duplicating validation rules.
 */
export function createStudioDiscoveryAdapter(options?: {
  catalogue?: ImmutablePlatformBlockCatalogueV2;
  context?: StudioDiscoveryContext;
}): StudioDiscoveryAdapter {
  const catalogue = options?.catalogue ?? IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2;
  const context = Object.freeze({ ...(options?.context ?? {}) });
  const isPublicPage = Boolean(context.isPublicPage || context.surface === "public");

  const projection = projectPlatformCatalogueDiscoveryV2(catalogue, {
    publicSurfaceOnly: isPublicPage,
  });

  const getComponentDiscovery = (
    blockIdOrKey: string,
  ): ComponentDiscoveryProjectionV2 | undefined => {
    return (
      projection.componentsByBlockId.get(blockIdOrKey) ??
      projection.componentsByKey.get(blockIdOrKey)
    );
  };

  const getAvailableComponents = (): readonly ComponentDiscoveryProjectionV2[] => {
    return projection.components;
  };

  const getAvailableComponentsByGroup = (): Readonly<
    Record<string, readonly ComponentDiscoveryProjectionV2[]>
  > => {
    const groups: Record<string, ComponentDiscoveryProjectionV2[]> = {};
    for (const comp of projection.components) {
      const group = comp.release.paletteGroup;
      if (!groups[group]) groups[group] = [];
      groups[group].push(comp);
    }
    const frozenGroups: Record<string, readonly ComponentDiscoveryProjectionV2[]> = {};
    for (const [k, v] of Object.entries(groups)) {
      frozenGroups[k] = Object.freeze(v);
    }
    return Object.freeze(frozenGroups);
  };

  const getReferenceChoices = (
    referenceKind: ComponentReferenceKindV2,
    refOptions?: { recordTypeId?: string },
  ): readonly InspectorReferenceChoice[] => {
    switch (referenceKind) {
      case "page_reference": {
        const pages = context.pages ?? [];
        return Object.freeze(
          pages.map((p) => ({
            id: p.pageId,
            key: p.key,
            label: p.name || p.key,
          })),
        );
      }
      case "query_reference": {
        const queries = context.queries ?? [];
        return Object.freeze(
          queries.map((q) => ({
            id: q.queryId,
            key: q.key,
            label: q.name || q.key,
          })),
        );
      }
      case "action_reference": {
        const actions = (context.actions ?? []).filter((a) => {
          if (isPublicPage && a.publicSurface === "refused") return false;
          return true;
        });
        return Object.freeze(
          actions.map((a) => ({
            id: a.actionId,
            key: a.key,
            label: a.name || a.key,
          })),
        );
      }
      case "record_type_reference": {
        const recordTypes = context.recordTypes ?? [];
        return Object.freeze(
          recordTypes.map((r) => ({
            id: r.recordTypeId,
            key: r.key,
            label: r.name || r.key,
          })),
        );
      }
      case "field_reference": {
        const fields = context.fields ?? [];
        const filtered = refOptions?.recordTypeId
          ? fields.filter((f) => f.recordTypeId === refOptions.recordTypeId)
          : fields;
        return Object.freeze(
          filtered.map((f) => ({
            id: f.fieldId,
            key: f.key,
            label: f.name || f.key,
          })),
        );
      }
      case "relationship_reference": {
        const relationships = context.relationships ?? [];
        const filtered = refOptions?.recordTypeId
          ? relationships.filter((r) => r.recordTypeId === refOptions.recordTypeId)
          : relationships;
        return Object.freeze(
          filtered.map((r) => ({
            id: r.relationshipId,
            key: r.key,
            label: r.name || r.key,
          })),
        );
      }
      case "pipeline_reference": {
        const pipelines = context.pipelines ?? [];
        return Object.freeze(
          pipelines.map((p) => ({
            id: p.pipelineId,
            key: p.key,
            label: p.name || p.key,
          })),
        );
      }
      case "asset_reference": {
        const assets = context.assets ?? [];
        return Object.freeze(
          assets.map((a) => ({
            id: a.assetId,
            key: a.assetId,
            label: a.name || a.assetId,
          })),
        );
      }
      case "record_reference": {
        const recordTypes = context.recordTypes ?? [];
        return Object.freeze(
          recordTypes.map((r) => ({
            id: r.recordTypeId,
            key: r.key,
            label: r.name || r.key,
          })),
        );
      }
      default:
        return Object.freeze([]);
    }
  };

  const projectPropertyChoices = (
    controls: readonly ComponentPropertyControlV2[],
    propOptions?: { recordTypeId?: string },
  ): readonly InspectorPropertyChoice[] => {
    return Object.freeze(
      controls.map((control) => {
        const choice: MutableInspectorPropertyChoice = {
          key: control.key,
          label: control.label,
          help: control.help,
          required: control.required,
          defaultValue: control.defaultValue,
          controlKind: control.kind,
          controlType: control.controlType,
          isReference: control.isReference,
          referenceKind: control.referenceKind,
        };

        if (control.textConstraints) choice.textConstraints = control.textConstraints;
        if (control.numberConstraints) choice.numberConstraints = control.numberConstraints;
        if (control.choiceOptions) choice.choiceOptions = control.choiceOptions;
        if (control.richTextAllowedElements)
          choice.allowedElements = control.richTextAllowedElements;
        if (control.listConstraints) choice.listConstraints = control.listConstraints;

        if (control.isReference && control.referenceKind) {
          choice.referenceChoices = getReferenceChoices(control.referenceKind, propOptions);
        }

        if (control.kind === "theme_token" && control.themeTokenKind) {
          const matching = (context.themeTokens ?? []).filter(
            (t) => t.tokenKind === control.themeTokenKind,
          );
          choice.themeTokenChoices = Object.freeze(matching);
        }

        if (control.nestedProperties) {
          choice.nestedProperties = projectPropertyChoices(
            control.nestedProperties,
            propOptions,
          );
        }

        if (control.listItemControl) {
          choice.listItem = projectPropertyChoices(
            [control.listItemControl],
            propOptions,
          )[0];
        }

        return Object.freeze(choice);
      }),
    );
  };

  const getAllowedChildBlocks = (
    blockIdOrKey: string,
    slotKey: string,
  ): readonly {
    blockId: string;
    key: string;
    releaseVersion: string;
    name: string;
    icon: string;
    paletteGroup: BlockPaletteGroup;
  }[] => {
    const comp = getComponentDiscovery(blockIdOrKey);
    if (!comp) return Object.freeze([]);
    const slot = comp.slots.find((s) => s.key === slotKey);
    if (!slot) return Object.freeze([]);
    return slot.allowedChildBlocks.map((b) =>
      Object.freeze({
        blockId: b.blockId,
        key: b.key,
        releaseVersion: b.releaseVersion,
        name: b.name,
        icon: b.icon,
        paletteGroup: b.paletteGroup,
      }),
    );
  };

  const getInspectorChoices = (
    blockIdOrKey: string,
    choicesOptions?: { recordTypeId?: string; slotKey?: string },
  ): ComponentInspectorChoices | undefined => {
    const comp = getComponentDiscovery(blockIdOrKey);
    if (!comp) return undefined;

    // Filter out if publicSurface is refused on a public page
    if (isPublicPage && comp.release.capabilities.publicSurface !== "allowed") {
      return undefined;
    }

    const properties = projectPropertyChoices(comp.propertyControls, choicesOptions);

    const slots: InspectorSlotChoice[] = comp.slots.map((slot) => ({
      slotKey: slot.key,
      slotLabel: slot.label,
      required: slot.required,
      allowedCategories: slot.allowedChildCategories,
      allowedChildBlocks: slot.allowedChildBlocks.map((b) => ({
        blockId: b.blockId,
        key: b.key,
        releaseVersion: b.releaseVersion,
        name: b.name,
        icon: b.icon,
        paletteGroup: b.paletteGroup,
      })),
    }));

    const operations: InspectorOperationChoice[] = comp.stateOperations.map((op) => ({
      key: op.key,
      label: op.label,
      description: op.description,
      category: op.category,
    }));

    return Object.freeze({
      component: Object.freeze({
        blockId: comp.release.blockId,
        key: comp.release.key,
        releaseVersion: comp.release.releaseVersion,
        name: comp.release.name,
        icon: comp.release.icon,
        paletteGroup: comp.release.paletteGroup,
        rendererKey: comp.release.rendererKey,
        publicSurface: comp.release.capabilities.publicSurface,
      }),
      properties,
      slots: Object.freeze(slots),
      operations: Object.freeze(operations),
      referenceKinds: comp.referenceKinds,
    });
  };

  const isPropertyOffered = (blockIdOrKey: string, propertyKey: string): boolean => {
    const choices = getInspectorChoices(blockIdOrKey);
    if (!choices) return false;
    const checkProperties = (props: readonly InspectorPropertyChoice[]): boolean => {
      for (const prop of props) {
        if (prop.key === propertyKey) return true;
        if (prop.nestedProperties && checkProperties(prop.nestedProperties)) return true;
        if (prop.listItem && prop.listItem.key === propertyKey) return true;
      }
      return false;
    };
    return checkProperties(choices.properties);
  };

  const isChildBlockOffered = (
    blockIdOrKey: string,
    slotKey: string,
    childBlockIdOrKey: string,
  ): boolean => {
    const children = getAllowedChildBlocks(blockIdOrKey, slotKey);
    return children.some(
      (child) => child.blockId === childBlockIdOrKey || child.key === childBlockIdOrKey,
    );
  };

  const isOperationOffered = (blockIdOrKey: string, operationKey: string): boolean => {
    const choices = getInspectorChoices(blockIdOrKey);
    if (!choices) return false;
    return choices.operations.some((op) => op.key === operationKey);
  };

  const isReferenceOffered = (
    referenceKind: ComponentReferenceKindV2,
    referenceIdOrKey: string,
    refOptions?: { recordTypeId?: string },
  ): boolean => {
    const choices = getReferenceChoices(referenceKind, refOptions);
    return choices.some(
      (choice) => choice.id === referenceIdOrKey || choice.key === referenceIdOrKey,
    );
  };

  const withContext = (updatedContext: StudioDiscoveryContext): StudioDiscoveryAdapter => {
    return createStudioDiscoveryAdapter({
      catalogue,
      context: { ...context, ...updatedContext },
    });
  };

  return Object.freeze({
    catalogue,
    context,
    projection,
    getComponentDiscovery,
    getAvailableComponents,
    getAvailableComponentsByGroup,
    getInspectorChoices,
    getAllowedChildBlocks,
    getReferenceChoices,
    isPropertyOffered,
    isChildBlockOffered,
    isOperationOffered,
    isReferenceOffered,
    withContext,
  });
}
