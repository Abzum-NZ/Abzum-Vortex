export const uiPackage = "@vortex/ui" as const;

// Platform Component Registry
export {
  createPlatformComponentRegistry,
  type PlatformBlockRenderProps,
  type PlatformComponentRegistration,
  type PlatformComponentRenderer,
  type PlatformComponentRegistry,
} from "./registry";

// Definition & Render Errors
export {
  DefinitionRenderError,
  validateAccessibleName,
  validatePlacementSlots,
  validateSlotOrder,
  type Breakpoint,
  type DefinitionRenderErrorCode,
  type DefinitionRenderErrorLocation,
} from "./definition-error";

// Layout-only Styles
export {
  computePlacementClassName,
  computePlacementStyle,
  computeSlotContainerStyle,
  LAYOUT_CLASS_NAMES,
  LAYOUT_ONLY_STYLES_CSS,
} from "./layout-styles";

// Layout Renderer & Recursive Traversal
export {
  PageLayoutRenderer,
  PlacementRenderer,
  PlacementSlotRenderer,
  renderPageLayout,
  resolveRootPlacementSlot,
  resolveShellLayout,
  type GuidedFormCompositionV2,
  type MaterialisedApplicationCompositionV2,
  type PageLayoutRendererProps,
  type PlacementRendererProps,
  type PlacementSlotRendererProps,
  type PlacementSlotV2,
  type ProjectedPageCapability,
} from "./layout-renderer";
