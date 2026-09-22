import React, { type ReactElement, type ReactNode } from "react";
import type {
  ApplicationContentV2,
  ApplicationShellV2,
  ApplicationThemeV2,
  BlockPlacementV2Contract,
  PageCompositionV2,
  PageDefinitionV2,
  PlacementLayoutV2Contract,
} from "@vortex/contracts";
import {
  DefinitionRenderError,
  validateAccessibleName,
  validatePlacementSlots,
  validateSlotOrder,
  type Breakpoint,
  type DefinitionRenderErrorLocation,
} from "./definition-error";
import {
  computePlacementClassName,
  computePlacementStyle,
  computeSlotContainerStyle,
  LAYOUT_CLASS_NAMES,
} from "./layout-styles";
import type { PlatformComponentRegistry } from "./registry";

export type PlacementSlotV2 = ApplicationShellV2["layout"];

/**
 * Shape of materialised application composition matching definition compilation output.
 */
export type MaterialisedApplicationCompositionV2 = Readonly<{
  platformBlockDependencies?: ApplicationContentV2["platformBlockDependencies"];
  shells: readonly ApplicationShellV2[];
  pages: ReadonlyArray<
    Readonly<{
      pageId: string;
      composition: PageCompositionV2 | GuidedFormCompositionV2;
      type?: string;
      steps?: readonly Readonly<{ id: string; key: string; name: string }>[];
    }>
  >;
  theme?: ApplicationThemeV2;
}>;

/**
 * Guided form composition contract shape.
 */
export type GuidedFormCompositionV2 =
  | Readonly<{
      shellKind: "default";
      stepContent: Readonly<Record<string, PlacementSlotV2>>;
    }>
  | Readonly<{
      shellKind: "application";
      shellId: string;
      stepContent: Readonly<Record<string, Readonly<Record<string, PlacementSlotV2>>>>;
    }>;

/**
 * Projected page capability shape from runtime/page permission projection.
 */
export type ProjectedPageCapability = Readonly<{
  pageId?: string;
  type?: string;
  composition:
    | Readonly<{ main: PlacementSlotV2 }>
    | Readonly<{ stepContent: Readonly<Record<string, PlacementSlotV2>> }>;
}>;

function cloneSlot(slot: PlacementSlotV2): PlacementSlotV2 {
  return {
    placements: Object.fromEntries(
      Object.entries(slot.placements).map(([placementId, placement]) => [
        placementId,
        {
          ...placement,
          settings: { ...placement.settings },
          themeOverrides: { ...placement.themeOverrides },
          responsive: { ...placement.responsive },
          slots: Object.fromEntries(
            Object.entries(placement.slots).map(([key, child]) => [key, cloneSlot(child)]),
          ),
        },
      ]),
    ),
    order: {
      desktop: [...slot.order.desktop],
      tablet: [...slot.order.tablet],
      phone: [...slot.order.phone],
    },
  };
}

function findPlacementInSlot(
  slot: PlacementSlotV2,
  placementId: string,
): BlockPlacementV2Contract | undefined {
  const direct = slot.placements[placementId];
  if (direct) return direct;
  for (const placement of Object.values(slot.placements)) {
    for (const child of Object.values(placement.slots)) {
      const found = findPlacementInSlot(child, placementId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Pure shell resolution: injects page content into the shell's declared content slots.
 */
export function resolveShellLayout(
  shell: ApplicationShellV2,
  content: Readonly<Record<string, PlacementSlotV2>>,
  location: DefinitionRenderErrorLocation = {},
): PlacementSlotV2 {
  const allowedSlotIds = new Set(shell.contentSlots.map((slot) => String(slot.slotId)));

  for (const slotId of Object.keys(content)) {
    if (!allowedSlotIds.has(slotId)) {
      throw new DefinitionRenderError(
        "UNDECLARED_CHILDREN",
        `Page content targets undeclared shell content slot '${slotId}' in shell '${shell.key}' (${shell.shellId})`,
        { ...location, shellId: shell.shellId, slotKey: slotId },
      );
    }
  }

  const root = cloneSlot(shell.layout);

  for (const binding of shell.contentSlots) {
    const slotId = String(binding.slotId);
    const supplied = content[slotId];

    if (
      binding.required &&
      (!supplied || Object.keys(supplied.placements).length === 0)
    ) {
      throw new DefinitionRenderError(
        "UNDECLARED_CHILDREN",
        `Required shell content slot '${binding.key}' (${slotId}) in shell '${shell.key}' has no content`,
        { ...location, shellId: shell.shellId, slotKey: binding.key },
      );
    }

    const parent = findPlacementInSlot(root, String(binding.parentPlacementId));
    if (!parent) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Shell content slot '${binding.key}' targets missing parent placement '${binding.parentPlacementId}'`,
        { ...location, shellId: shell.shellId, slotKey: binding.key },
      );
    }

    const reserved = parent.slots[binding.parentSlotKey];
    if (!reserved) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Shell parent placement '${binding.parentPlacementId}' does not declare slot '${binding.parentSlotKey}'`,
        { ...location, shellId: shell.shellId, slotKey: binding.parentSlotKey },
      );
    }

    const emptySlot: PlacementSlotV2 = {
      placements: {},
      order: { desktop: [], tablet: [], phone: [] },
    };

    parent.slots[binding.parentSlotKey] = cloneSlot(supplied ?? emptySlot);
  }

  return root;
}

/**
 * Props for rendering an individual placement.
 */
export type PlacementRendererProps = Readonly<{
  placementId: string;
  placement: BlockPlacementV2Contract;
  breakpoint: Breakpoint;
  registry: PlatformComponentRegistry;
  className?: string;
  style?: React.CSSProperties;
  location?: DefinitionRenderErrorLocation;
}>;

/**
 * Renders an individual placement with deterministic layout, sizing, and recursive slots.
 * Fails closed on any metadata or contract error; never falls back to arbitrary output.
 */
export function PlacementRenderer({
  placementId,
  placement,
  breakpoint,
  registry,
  className,
  style,
  location = {},
}: PlacementRendererProps): ReactElement {
  const currentLocation: DefinitionRenderErrorLocation = {
    ...location,
    placementId,
    blockId: placement.block.blockId,
    releaseVersion: placement.block.releaseVersion,
    breakpoint,
  };

  // 1. Registry lookup
  const registration = registry.get(placement.block.blockId, placement.block.releaseVersion);
  if (!registration) {
    if (registry.hasBlockId(placement.block.blockId)) {
      throw new DefinitionRenderError(
        "MISMATCHED_RELEASE",
        `Placement '${placementId}' references mismatched release version '${placement.block.releaseVersion}' for block '${placement.block.blockId}'`,
        currentLocation,
      );
    }
    throw new DefinitionRenderError(
      "UNKNOWN_RELEASE",
      `Placement '${placementId}' references unknown block '${placement.block.blockId}' release '${placement.block.releaseVersion}'`,
      currentLocation,
    );
  }

  const { metadata, render: Component } = registration;

  // 2. Validate renderer key
  if (!metadata.rendererKey || metadata.rendererKey.trim().length === 0 || !Component) {
    throw new DefinitionRenderError(
      "ABSENT_RENDERER_KEY",
      `Block '${metadata.key}' (${metadata.blockId}:${metadata.releaseVersion}) has absent or empty renderer key`,
      currentLocation,
    );
  }

  // 3. Validate accessible name
  validateAccessibleName(placement.settings, metadata.capabilities, currentLocation);

  // 4. Validate child slots and child category restrictions
  validatePlacementSlots(placement, metadata, registry, currentLocation);

  // 5. Recursively render declared named child slots in deterministic order
  const renderedSlots: Record<string, ReactNode> = {};
  for (const declaredSlot of metadata.slots) {
    const childSlot = placement.slots[declaredSlot.key];
    if (childSlot && Object.keys(childSlot.placements).length > 0) {
      renderedSlots[declaredSlot.key] = (
        <PlacementSlotRenderer
          slot={childSlot}
          slotKey={declaredSlot.key}
          breakpoint={breakpoint}
          registry={registry}
          parentPlacementId={placementId}
          location={{ ...currentLocation, slotKey: declaredSlot.key }}
        />
      );
    } else {
      renderedSlots[declaredSlot.key] = null;
    }
  }

  // 6. Apply declared visibility, content/fill/grid placement and content/bounded-height sizing
  const layout = placement.responsive[breakpoint] as PlacementLayoutV2Contract | undefined;
  const placementStyle = computePlacementStyle(layout, breakpoint);
  const placementClassName = computePlacementClassName(layout, breakpoint);

  const combinedStyle: React.CSSProperties = {
    ...placementStyle,
    ...style,
  };

  const combinedClassName = className
    ? `${placementClassName} ${className}`
    : placementClassName;

  return (
    <div
      data-vortex-placement-id={placementId}
      data-vortex-block-id={metadata.blockId}
      data-vortex-block-key={metadata.key}
      data-vortex-breakpoint={breakpoint}
      data-vortex-visible={layout ? String(layout.visible) : "true"}
      className={combinedClassName}
      style={combinedStyle}
    >
      <Component
        placementId={placementId}
        settings={placement.settings}
        slots={renderedSlots}
        breakpoint={breakpoint}
        metadata={metadata}
        themeOverrides={placement.themeOverrides}
      />
    </div>
  );
}

/**
 * Props for rendering a placement slot.
 */
export type PlacementSlotRendererProps = Readonly<{
  slot: PlacementSlotV2;
  slotKey?: string;
  breakpoint: Breakpoint;
  registry: PlatformComponentRegistry;
  parentPlacementId?: string;
  className?: string;
  style?: React.CSSProperties;
  location?: DefinitionRenderErrorLocation;
}>;

/**
 * Renders a placement slot's children in deterministic breakpoint order.
 */
export function PlacementSlotRenderer({
  slot,
  slotKey,
  breakpoint,
  registry,
  parentPlacementId,
  className,
  style,
  location = {},
}: PlacementSlotRendererProps): ReactElement {
  const currentLocation: DefinitionRenderErrorLocation = {
    ...location,
    slotKey,
    placementId: parentPlacementId,
    breakpoint,
  };

  // Validate deterministic child ordering
  const orderedIds = validateSlotOrder(slot, breakpoint, currentLocation);

  // Check if any child placement declares 12-column grid width
  const hasGridChildren = orderedIds.some((id) => {
    const child = slot.placements[id];
    const layout = child?.responsive[breakpoint];
    return layout?.width.kind === "grid";
  });

  const containerStyle: React.CSSProperties = {
    ...computeSlotContainerStyle(hasGridChildren),
    ...style,
  };

  const containerClassName = hasGridChildren
    ? LAYOUT_CLASS_NAMES.gridContainer
    : LAYOUT_CLASS_NAMES.slotContainer;

  const combinedClassName = className
    ? `${containerClassName} ${className}`
    : containerClassName;

  return (
    <div
      data-vortex-slot-key={slotKey ?? "root"}
      data-vortex-breakpoint={breakpoint}
      className={combinedClassName}
      style={containerStyle}
    >
      {orderedIds.map((childId) => {
        const childPlacement = slot.placements[childId]!;
        return (
          <PlacementRenderer
            key={childId}
            placementId={childId}
            placement={childPlacement}
            breakpoint={breakpoint}
            registry={registry}
            location={currentLocation}
          />
        );
      })}
    </div>
  );
}

/**
 * Props for top-level PageLayoutRenderer.
 */
export type PageLayoutRendererProps = Readonly<{
  composition:
    | MaterialisedApplicationCompositionV2
    | PageDefinitionV2
    | PageCompositionV2
    | GuidedFormCompositionV2
    | ProjectedPageCapability;
  breakpoint?: Breakpoint;
  registry: PlatformComponentRegistry;
  shells?: readonly ApplicationShellV2[];
  pageId?: string;
  activeStepId?: string;
  className?: string;
  style?: React.CSSProperties;
}>;

/**
 * Top-level layout renderer for pages, application shells, and guided steps.
 * Consumes MaterialisedApplicationCompositionV2 or permission-projected page capability.
 */
export function PageLayoutRenderer({
  composition,
  breakpoint = "desktop",
  registry,
  shells = [],
  pageId,
  activeStepId,
  className,
  style,
}: PageLayoutRendererProps): ReactElement {
  const rootSlot = resolveRootPlacementSlot({
    composition,
    shells,
    pageId,
    activeStepId,
  });

  return (
    <PlacementSlotRenderer
      slot={rootSlot}
      breakpoint={breakpoint}
      registry={registry}
      className={className}
      style={style}
      location={{ pageId, stepId: activeStepId, breakpoint }}
    />
  );
}

/**
 * Resolves the root placement slot from various composition input formats:
 * - MaterialisedApplicationCompositionV2
 * - ProjectedPageCapability
 * - PageDefinitionV2
 * - PageCompositionV2 | GuidedFormCompositionV2
 */
export function resolveRootPlacementSlot(options: {
  composition:
    | MaterialisedApplicationCompositionV2
    | PageDefinitionV2
    | PageCompositionV2
    | GuidedFormCompositionV2
    | ProjectedPageCapability;
  shells?: readonly ApplicationShellV2[];
  pageId?: string;
  activeStepId?: string;
}): PlacementSlotV2 {
  const { composition, pageId, activeStepId } = options;
  const availableShells = [...(options.shells ?? [])];

  // Case 1: MaterialisedApplicationCompositionV2
  if ("pages" in composition && Array.isArray(composition.pages)) {
    const allShells = [...availableShells, ...(composition.shells ?? [])];
    const targetPage = pageId
      ? composition.pages.find((page) => page.pageId === pageId)
      : composition.pages[0];

    if (!targetPage) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Target page '${pageId ?? "default"}' not found in materialised composition`,
        { pageId },
      );
    }

    return resolvePageCompositionSlot({
      composition: targetPage.composition,
      shells: allShells,
      pageId: targetPage.pageId,
      activeStepId,
      orderedSteps: targetPage.steps,
    });
  }

  // Case 2: PageDefinitionV2
  if ("type" in composition && "composition" in composition && "name" in composition) {
    const page = composition as PageDefinitionV2;
    return resolvePageCompositionSlot({
      composition: page.composition,
      shells: availableShells,
      pageId: page.pageId,
      activeStepId,
      orderedSteps: page.type === "guided_form" ? page.steps : undefined,
    });
  }

  // Case 3: ProjectedPageCapability
  if ("composition" in composition) {
    const projectedComp = composition.composition;
    if ("main" in projectedComp) {
      return projectedComp.main;
    }
    if ("stepContent" in projectedComp) {
      const stepMap = projectedComp.stepContent;
      const stepId = activeStepId ?? Object.keys(stepMap)[0];
      if (!stepId || !stepMap[stepId]) {
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Guided step '${activeStepId ?? "first"}' has no projected content`,
          { stepId: activeStepId },
        );
      }
      return stepMap[stepId]!;
    }
  }

  // Case 4: Direct PageCompositionV2 | GuidedFormCompositionV2
  return resolvePageCompositionSlot({
    composition: composition as PageCompositionV2 | GuidedFormCompositionV2,
    shells: availableShells,
    pageId,
    activeStepId,
  });
}

function resolvePageCompositionSlot(options: {
  composition: PageCompositionV2 | GuidedFormCompositionV2;
  shells: readonly ApplicationShellV2[];
  pageId?: string;
  activeStepId?: string;
  orderedSteps?: readonly Readonly<{ id: string; key: string }>[];
}): PlacementSlotV2 {
  const { composition, shells, pageId, activeStepId, orderedSteps } = options;

  // Standard Page with default shell
  if (composition.shellKind === "default" && "main" in composition) {
    return composition.main;
  }

  // Standard Page with application shell
  if (composition.shellKind === "application" && "content" in composition) {
    const shell = shells.find((candidate) => candidate.shellId === composition.shellId);
    if (!shell) {
      throw new DefinitionRenderError(
        "UNRESOLVED_SHELL",
        `Shell '${composition.shellId}' referenced by page '${pageId ?? "unknown"}' not found`,
        { pageId, shellId: composition.shellId },
      );
    }
    return resolveShellLayout(shell, composition.content, { pageId, shellId: shell.shellId });
  }

  // Guided Form with default shell
  if (composition.shellKind === "default" && "stepContent" in composition) {
    const stepMap = composition.stepContent;
    const resolvedStepId =
      activeStepId ??
      orderedSteps?.[0]?.id ??
      Object.keys(stepMap)[0];

    if (!resolvedStepId || !stepMap[resolvedStepId]) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Guided step '${resolvedStepId ?? "unknown"}' has no step content`,
        { pageId, stepId: resolvedStepId },
      );
    }
    return stepMap[resolvedStepId]!;
  }

  // Guided Form with application shell
  if (composition.shellKind === "application" && "stepContent" in composition) {
    const shell = shells.find((candidate) => candidate.shellId === composition.shellId);
    if (!shell) {
      throw new DefinitionRenderError(
        "UNRESOLVED_SHELL",
        `Shell '${composition.shellId}' referenced by guided page '${pageId ?? "unknown"}' not found`,
        { pageId, shellId: composition.shellId },
      );
    }

    const stepMap = composition.stepContent;
    const resolvedStepId =
      activeStepId ??
      orderedSteps?.[0]?.id ??
      Object.keys(stepMap)[0];

    if (!resolvedStepId || !stepMap[resolvedStepId]) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Guided step '${resolvedStepId ?? "unknown"}' has no step content in shell '${shell.shellId}'`,
        { pageId, shellId: shell.shellId, stepId: resolvedStepId },
      );
    }

    const stepSlotContent = stepMap[resolvedStepId]!;
    return resolveShellLayout(shell, stepSlotContent, {
      pageId,
      shellId: shell.shellId,
      stepId: resolvedStepId,
    });
  }

  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    "Unrecognised page composition structure",
    { pageId },
  );
}

/**
 * Pure render helper that executes recursive layout traversal and returns the root ReactElement.
 */
export function renderPageLayout(props: PageLayoutRendererProps): ReactElement {
  return <PageLayoutRenderer {...props} />;
}
