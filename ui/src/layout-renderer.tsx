"use client";

import type { CSSProperties, ReactElement, ReactNode } from "react";
import type {
  ApplicationContentV2,
  ApplicationShellV2,
  BlockPlacementV2Contract,
  GuidedFormPageCompositionV2,
  PageCompositionV2,
  PageDefinitionV2,
} from "@vortex/contracts";
import {
  ALL_UI_STYLES_CSS,
  createThemeRootProps,
  resolvePlacementTheme,
  type ApplicationThemeV2,
  type PlacementThemeScope,
  type ThemeMode,
} from "./theme";
import {
  DefinitionRenderError,
  validateAccessibleName,
  validatePlacementSlots,
  validatePlacementTree,
  validateSlotOrder,
  type Breakpoint,
  type DefinitionRenderErrorLocation,
} from "./definition-error";
import {
  computePlacementClassName,
  computePlacementStyle,
  computeResponsivePlacementCss,
  computeSlotContainerStyle,
  LAYOUT_CLASS_NAMES,
  RESPONSIVE_BREAKPOINT_ORDER,
  slotDeclaresGridChildren,
} from "./layout-styles";
import { LayoutBreakpointProvider, useLayoutBreakpoint } from "./breakpoint";
import type { PlatformComponentRegistry } from "./registry";
import { DateFormatProvider } from "./display/date-format-context";
import {
  assertProjectionKeysArePlacements,
  parseDisplayEventHandlers,
  parseProjectedDisplayData,
  type DisplayEventsByPlacement,
  type ProjectedDataByPlacement,
} from "./display/projected-data";
import {
  assertControlProjectionKeysArePlacements,
  parseControlEventHandlers,
  parseProjectedControlData,
  type ControlEventsByPlacement,
  type ProjectedControlDataByPlacement,
} from "./controls/projected-data";

export type PlacementSlotV2 = ApplicationShellV2["layout"];

/**
 * Shape of materialised application composition matching definition compilation output.
 */
export type MaterialisedApplicationCompositionV2 = Readonly<{
  platformBlockDependencies: ApplicationContentV2["platformBlockDependencies"];
  shells: readonly ApplicationShellV2[];
  pages: ReadonlyArray<
    Readonly<{
      pageId: string;
      composition: PageCompositionV2 | GuidedFormPageCompositionV2;
      steps?: readonly Readonly<{ id: string }>[];
    }>
  >;
  theme: ApplicationThemeV2;
}>;

/**
 * Guided form composition contract shape.
 */
export type GuidedFormCompositionV2 = GuidedFormPageCompositionV2;

/**
 * Projected page capability shape from runtime/page permission projection.
 */
export type ProjectedPageCapability = Readonly<{
  pageId?: string;
  type?: string;
  steps?: readonly Readonly<{ id: string; name?: string; summary?: boolean }>[];
  composition:
    | Readonly<{ main: ProjectedPlacementSlot }>
    | Readonly<{ stepContent: Readonly<Record<string, ProjectedPlacementSlot>> }>;
}>;

export type ProjectedPlacementAvailability = Readonly<{
  availability?: "unavailable";
  unavailableReason?: "operation_unavailable";
}>;

export type ProjectedPlacementSlot = PlacementSlotV2 &
  Readonly<{
    placements: Record<string, BlockPlacementV2Contract & ProjectedPlacementAvailability>;
  }>;

const projectedAvailability = (
  placement: BlockPlacementV2Contract,
  location: DefinitionRenderErrorLocation,
): Readonly<{
  availability: "available" | "unavailable";
  unavailableReason?: "operation_unavailable";
}> => {
  const hasAvailability = "availability" in placement;
  const hasReason = "unavailableReason" in placement;
  if (!hasAvailability && !hasReason) return { availability: "available" };
  if (
    !hasAvailability ||
    placement.availability !== "unavailable" ||
    !hasReason ||
    placement.unavailableReason !== "operation_unavailable"
  ) {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Projected placement availability must use the fixed operation-unavailable state",
      location,
    );
  }
  return { availability: "unavailable", unavailableReason: "operation_unavailable" };
};

const validateProjectedAvailabilityTree = (
  slot: PlacementSlotV2,
  location: DefinitionRenderErrorLocation,
): void => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    const placementLocation = { ...location, placementId };
    projectedAvailability(placement, placementLocation);
    for (const [slotKey, childSlot] of Object.entries(placement.slots))
      validateProjectedAvailabilityTree(childSlot, { ...placementLocation, slotKey });
  }
};

const validatePlacementDependencies = (
  slot: PlacementSlotV2,
  dependencies: ApplicationContentV2["platformBlockDependencies"],
  location: DefinitionRenderErrorLocation,
): void => {
  const releases = new Map(
    dependencies.map((dependency) => [dependency.blockId, dependency.releaseVersion]),
  );
  const visit = (current: PlacementSlotV2, currentLocation: DefinitionRenderErrorLocation): void => {
    for (const [placementId, placement] of Object.entries(current.placements)) {
      const placementLocation = {
        ...currentLocation,
        placementId,
        blockId: placement.block.blockId,
        releaseVersion: placement.block.releaseVersion,
      };
      if (releases.get(placement.block.blockId) !== placement.block.releaseVersion) {
        throw new DefinitionRenderError(
          "MISMATCHED_RELEASE",
          `Placement '${placementId}' does not match the materialised platform-block dependency manifest`,
          placementLocation,
        );
      }
      for (const [slotKey, childSlot] of Object.entries(placement.slots))
        visit(childSlot, { ...placementLocation, slotKey });
    }
  };
  visit(slot, location);
};

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

function findPlacementsInSlot(
  slot: PlacementSlotV2,
  placementId: string,
  matches: BlockPlacementV2Contract[] = [],
): readonly BlockPlacementV2Contract[] {
  const direct = slot.placements[placementId];
  if (direct) matches.push(direct);
  for (const placement of Object.values(slot.placements)) {
    for (const child of Object.values(placement.slots))
      findPlacementsInSlot(child, placementId, matches);
  }
  return matches;
}

/** Reads only an own entry keyed by exact stable placement identity. */
const ownPlacementEntry = <Value,>(
  entries: Readonly<Record<string, Value>> | undefined,
  placementId: string,
): Value | undefined =>
  entries !== undefined && Object.hasOwn(entries, placementId) ? entries[placementId] : undefined;

function collectPlacementIds(
  slot: PlacementSlotV2,
  ids: Set<string> = new Set<string>(),
): Set<string> {
  for (const [id, placement] of Object.entries(slot.placements)) {
    ids.add(id);
    for (const child of Object.values(placement.slots)) {
      collectPlacementIds(child, ids);
    }
  }
  return ids;
}

/**
 * Pure shell resolution: injects page content into the shell's declared content slots.
 */
export function resolveShellLayout(
  shell: ApplicationShellV2,
  content: Readonly<Record<string, PlacementSlotV2>>,
  location: DefinitionRenderErrorLocation = {},
  registry?: PlatformComponentRegistry,
): PlacementSlotV2 {
  const allowedSlotIds = new Set(shell.contentSlots.map((slot) => String(slot.slotId)));
  const slotKeys = new Set(shell.contentSlots.map((slot) => slot.key));
  const targetKeys = new Set(
    shell.contentSlots.map((slot) => `${slot.parentPlacementId}:${slot.parentSlotKey}`),
  );
  if (
    allowedSlotIds.size !== shell.contentSlots.length ||
    slotKeys.size !== shell.contentSlots.length ||
    targetKeys.size !== shell.contentSlots.length
  ) {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Shell '${shell.key}' (${shell.shellId}) has duplicate content-slot identities, keys, or targets`,
      { ...location, shellId: shell.shellId },
    );
  }

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

    if (supplied !== undefined && registry !== undefined) {
      const allowedCategories = new Set(binding.allowedChildCategories);
      for (const [childPlacementId, childPlacement] of Object.entries(supplied.placements)) {
        const registration = registry.get(
          childPlacement.block.blockId,
          childPlacement.block.releaseVersion,
        );
        if (registration === undefined) {
          throw new DefinitionRenderError(
            registry.hasBlockId(childPlacement.block.blockId)
              ? "MISMATCHED_RELEASE"
              : "UNKNOWN_RELEASE",
            `Shell content slot '${binding.key}' references unavailable block release '${childPlacement.block.blockId}:${childPlacement.block.releaseVersion}'`,
            {
              ...location,
              shellId: shell.shellId,
              slotKey: binding.key,
              childPlacementId,
              blockId: childPlacement.block.blockId,
              releaseVersion: childPlacement.block.releaseVersion,
            },
          );
        }
        if (!allowedCategories.has(registration.metadata.paletteGroup)) {
          throw new DefinitionRenderError(
            "ILLEGAL_CHILDREN",
            `Child block '${registration.metadata.key}' is not allowed in shell content slot '${binding.key}'`,
            {
              ...location,
              shellId: shell.shellId,
              slotKey: binding.key,
              childPlacementId,
              blockId: registration.metadata.blockId,
              releaseVersion: registration.metadata.releaseVersion,
            },
          );
        }
      }
    }

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

    const parentMatches = findPlacementsInSlot(root, String(binding.parentPlacementId));
    const parent = parentMatches[0];
    if (parentMatches.length !== 1 || parent === undefined) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Shell content slot '${binding.key}' must target exactly one parent placement '${binding.parentPlacementId}'`,
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
    if (
      Object.keys(reserved.placements).length > 0 ||
      reserved.order.desktop.length > 0 ||
      reserved.order.tablet.length > 0 ||
      reserved.order.phone.length > 0
    ) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Shell content slot '${binding.key}' must target an empty reserved child slot`,
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
  style?: CSSProperties;
  location?: DefinitionRenderErrorLocation;
  /** Permission projection may remove otherwise required child content. */
  allowEmptyRequiredSlots?: boolean;
  /** Permission-projected display data keyed by stable placement identity. */
  projectedData?: ProjectedDataByPlacement | undefined;
  /** Semantic callbacks keyed by stable placement identity. */
  displayEvents?: DisplayEventsByPlacement | undefined;
  /** Permission-projected control data keyed by stable placement identity. */
  controlData?: ProjectedControlDataByPlacement | undefined;
  /** Control semantic callbacks keyed by stable placement identity. */
  controlEvents?: ControlEventsByPlacement | undefined;
  /** Theme tokens in force where this placement renders. */
  themeScope?: PlacementThemeScope | undefined;
  /**
   * Live-page mode. Per-breakpoint geometry comes from the generated responsive stylesheet and the
   * current breakpoint only selects child order; preview keeps the explicit single-breakpoint
   * inline styles instead.
   */
  responsive?: boolean | undefined;
}>;

const EMPTY_THEME_SCOPE: PlacementThemeScope = Object.freeze({ application: {}, inherited: {} });

/**
 * Renders an individual placement with deterministic layout, sizing, and recursive slots.
 * Validates its whole subtree once, then fails closed on any metadata or contract error;
 * never falls back to arbitrary output.
 */
export function PlacementRenderer(props: PlacementRendererProps): ReactElement {
  const { placementId, placement, breakpoint, registry, location = {} } = props;
  const slot: PlacementSlotV2 = {
    placements: { [placementId]: placement },
    order: { desktop: [placementId], tablet: [placementId], phone: [placementId] },
  };
  validatePlacementTree(slot, registry, { ...location, breakpoint }, {
    allowEmptyRequiredSlots: props.allowEmptyRequiredSlots ?? false,
  });
  validateProjectedAvailabilityTree(slot, { ...location, breakpoint });
  return <PlacementView {...props} />;
}

/** Renders one placement of an already validated tree. */
function PlacementView({
  placementId,
  placement,
  breakpoint,
  registry,
  className,
  style,
  location = {},
  allowEmptyRequiredSlots = false,
  projectedData,
  displayEvents,
  controlData,
  controlEvents,
  themeScope = EMPTY_THEME_SCOPE,
  responsive = false,
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
  validatePlacementSlots(placement, metadata, registry, currentLocation, {
    allowEmptyRequiredSlots,
  });

  // 5. Parse this placement's own projected data and callbacks, fail-closed. A placement whose
  //    use is unavailable stays viewable but never receives an invocable callback.
  const availability = projectedAvailability(placement, currentLocation);
  const suppliedData = ownPlacementEntry(projectedData, placementId);
  const placementData =
    suppliedData === undefined ? undefined : parseProjectedDisplayData(suppliedData, currentLocation);
  const suppliedEvents =
    availability.availability === "available"
      ? ownPlacementEntry(displayEvents, placementId)
      : undefined;
  const placementEvents =
    suppliedEvents === undefined
      ? undefined
      : parseDisplayEventHandlers(suppliedEvents, currentLocation);

  const suppliedControlData = ownPlacementEntry(controlData, placementId);
  const placementControlData =
    suppliedControlData === undefined
      ? undefined
      : parseProjectedControlData(suppliedControlData, currentLocation);
  const suppliedControlEvents =
    availability.availability === "available"
      ? ownPlacementEntry(controlEvents, placementId)
      : undefined;
  const placementControlEvents =
    suppliedControlEvents === undefined
      ? undefined
      : parseControlEventHandlers(suppliedControlEvents, currentLocation);

  // Declared theme overrides apply to this placement and its subtree. A re-themed placement is
  // also a theme root, so its surface, text and typography repaint from its own variables
  // rather than keeping the values its ancestors computed.
  const placementTheme = resolvePlacementTheme(themeScope, placement.themeOverrides);

  // 6. Recursively render declared named child slots in deterministic order
  const renderedSlots: Record<string, ReactNode> = {};
  for (const declaredSlot of metadata.slots) {
    const childSlot = placement.slots[declaredSlot.key];
    if (childSlot && Object.keys(childSlot.placements).length > 0) {
      renderedSlots[declaredSlot.key] = (
        <PlacementSlotView
          slot={childSlot}
          slotKey={declaredSlot.key}
          breakpoint={breakpoint}
          registry={registry}
          parentPlacementId={placementId}
          location={{ ...currentLocation, slotKey: declaredSlot.key }}
          allowEmptyRequiredSlots={allowEmptyRequiredSlots}
          projectedData={projectedData}
          displayEvents={displayEvents}
          controlData={controlData}
          controlEvents={controlEvents}
          themeScope={placementTheme.scope}
        />
      );
    } else {
      renderedSlots[declaredSlot.key] = null;
    }
  }

  // 7. Apply declared visibility, content/fill/grid placement and content/bounded-height sizing.
  //    Live pages take all of it from the generated per-breakpoint stylesheet; the current
  //    breakpoint only labels the element and decides child order. A placement visible at any
  //    breakpoint must stay in the document so a narrower media rule can reveal it.
  const layout = placement.responsive[breakpoint];
  const placementStyle = responsive ? undefined : computePlacementStyle(layout, breakpoint);
  const placementClassName = responsive
    ? LAYOUT_CLASS_NAMES.placementWrapper
    : computePlacementClassName(layout, breakpoint);
  const visible = responsive
    ? RESPONSIVE_BREAKPOINT_ORDER.some((candidate) => placement.responsive[candidate].visible)
    : layout.visible;

  const combinedStyle: CSSProperties = {
    ...style,
    ...placementTheme.style,
    ...(placementStyle === undefined ? {} : placementStyle),
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
      data-vortex-visible={String(layout.visible)}
      {...(placementTheme.style === undefined ? {} : { "data-vortex-theme": "" })}
      className={combinedClassName}
      style={combinedStyle}
    >
      {visible ? (
        <Component
          placementId={placementId}
          settings={placement.settings}
          slots={renderedSlots}
          breakpoint={breakpoint}
          metadata={metadata}
          themeOverrides={placement.themeOverrides}
          {...availability}
          {...(placementData === undefined ? {} : { projectedData: placementData })}
          {...(placementEvents === undefined ? {} : { displayEvents: placementEvents })}
          {...(placementControlData === undefined ? {} : { controlData: placementControlData })}
          {...(placementControlEvents === undefined ? {} : { controlEvents: placementControlEvents })}
        />
      ) : null}
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
  style?: CSSProperties;
  location?: DefinitionRenderErrorLocation;
  /** Permission projection may remove otherwise required child content. */
  allowEmptyRequiredSlots?: boolean;
  /** Permission-projected display data keyed by stable placement identity. */
  projectedData?: ProjectedDataByPlacement | undefined;
  /** Semantic callbacks keyed by stable placement identity. */
  displayEvents?: DisplayEventsByPlacement | undefined;
  /** Permission-projected control data keyed by stable placement identity. */
  controlData?: ProjectedControlDataByPlacement | undefined;
  /** Control semantic callbacks keyed by stable placement identity. */
  controlEvents?: ControlEventsByPlacement | undefined;
  /** Theme tokens in force where this slot renders. */
  themeScope?: PlacementThemeScope | undefined;
  /**
   * Live-page mode. Children still follow the current breakpoint's declared order, but the slot
   * container and per-breakpoint geometry come from the generated responsive stylesheet.
   */
  responsive?: boolean | undefined;
}>;

/**
 * Renders a placement slot's children in deterministic breakpoint order, validating the slot's
 * whole subtree once before any registered renderer is invoked.
 */
export function PlacementSlotRenderer(props: PlacementSlotRendererProps): ReactElement {
  const { slot, slotKey, breakpoint, registry, parentPlacementId, location = {} } = props;
  const slotLocation: DefinitionRenderErrorLocation = {
    ...location,
    ...(slotKey === undefined ? {} : { slotKey }),
    ...(parentPlacementId === undefined ? {} : { placementId: parentPlacementId }),
    breakpoint,
  };
  validatePlacementTree(slot, registry, slotLocation, {
    allowEmptyRequiredSlots: props.allowEmptyRequiredSlots ?? false,
  });
  validateProjectedAvailabilityTree(slot, slotLocation);
  return <PlacementSlotView {...props} />;
}

/** Renders one slot of an already validated tree. */
function PlacementSlotView({
  slot,
  slotKey,
  breakpoint,
  registry,
  parentPlacementId,
  className,
  style,
  location = {},
  allowEmptyRequiredSlots = false,
  projectedData,
  displayEvents,
  controlData,
  controlEvents,
  themeScope,
  responsive = false,
}: PlacementSlotRendererProps): ReactElement {
  const currentLocation: DefinitionRenderErrorLocation = {
    ...location,
    ...(slotKey === undefined ? {} : { slotKey }),
    ...(parentPlacementId === undefined ? {} : { placementId: parentPlacementId }),
    breakpoint,
  };

  // Validate deterministic child ordering for the current breakpoint. Live pages read the child
  // order of the visitor's breakpoint, so focus order follows the meaningful reading order.
  const orderedIds = validateSlotOrder(slot, breakpoint, currentLocation);

  // Check if any child placement declares 12-column grid width. A live slot keeps one container
  // mode across breakpoints; the generated rules make each child fill or span per breakpoint.
  const hasGridChildren = responsive
    ? slotDeclaresGridChildren(slot)
    : orderedIds.some((id) => {
        const child = slot.placements[id];
        const layout = child?.responsive[breakpoint];
        return layout?.visible === true && layout.width.kind === "grid";
      });

  const containerStyle: CSSProperties = {
    ...style,
    ...computeSlotContainerStyle(hasGridChildren),
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
        const childPlacement = slot.placements[childId];
        if (childPlacement === undefined) {
          throw new DefinitionRenderError(
            "INCOMPLETE_CHILD_ORDERING",
            `Ordered child placement '${childId}' is missing`,
            { ...currentLocation, childPlacementId: childId },
          );
        }
        const childLayout = childPlacement.responsive[breakpoint];
        const gridItemStyle =
          !responsive && hasGridChildren && childLayout.width.kind !== "grid"
            ? ({ gridColumn: "1 / -1" } satisfies CSSProperties)
            : undefined;
        return (
          <PlacementView
            key={childId}
            placementId={childId}
            placement={childPlacement}
            breakpoint={breakpoint}
            registry={registry}
            location={currentLocation}
            {...(gridItemStyle === undefined ? {} : { style: gridItemStyle })}
            allowEmptyRequiredSlots={allowEmptyRequiredSlots}
            projectedData={projectedData}
            displayEvents={displayEvents}
            controlData={controlData}
            controlEvents={controlEvents}
            themeScope={themeScope}
            responsive={responsive}
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
  style?: CSSProperties;
  /**
   * Permission-projected display data keyed by stable placement identity. Every key must
   * name a placement in the resolved tree; each entry is parsed fail-closed at its placement.
   */
  projectedData?: ProjectedDataByPlacement;
  /** Semantic callbacks keyed by stable placement identity; the renderer never invokes them. */
  displayEvents?: DisplayEventsByPlacement;
  /**
   * Permission-projected control data keyed by stable placement identity.
   */
  controlData?: ProjectedControlDataByPlacement;
  /** Control semantic callbacks keyed by stable placement identity. */
  controlEvents?: ControlEventsByPlacement;
  /**
   * Resolved #594 application theme. Defaults to the materialised composition's theme;
   * without one the readable platform defaults apply.
   */
  theme?: ApplicationThemeV2 | undefined;
  /** Light, dark or system appearance for the runtime page or preview canvas. */
  themeMode?: ThemeMode | undefined;
  /** Organisation or viewer BCP 47 locale for date presentation. */
  locale?: string | undefined;
  /** Organisation or viewer IANA time zone for timestamp presentation. */
  timeZone?: string | undefined;
}>;

/**
 * Top-level layout renderer for pages, application shells, and guided steps.
 * Consumes MaterialisedApplicationCompositionV2 or permission-projected page capability.
 */
export function PageLayoutRenderer({
  composition,
  breakpoint,
  registry,
  shells = [],
  pageId,
  activeStepId,
  className,
  style,
  projectedData,
  displayEvents,
  controlData,
  controlEvents,
  theme,
  themeMode,
  locale,
  timeZone,
}: PageLayoutRendererProps): ReactElement {
  const resolved = resolveRootPlacementSlotWithContext({
    composition,
    shells,
    registry,
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { activeStepId }),
  });
  if ("pages" in composition && Array.isArray(composition.pages))
    validatePlacementDependencies(
      resolved.slot,
      composition.platformBlockDependencies,
      pageId === undefined ? {} : { pageId },
    );

  const location: DefinitionRenderErrorLocation = {
    ...(pageId === undefined ? {} : { pageId }),
    ...(activeStepId === undefined ? {} : { stepId: activeStepId }),
    ...(breakpoint === undefined ? {} : { breakpoint }),
  };

  validatePlacementTree(resolved.slot, registry, location, {
    allowEmptyRequiredSlots: resolved.permissionProjected,
  });
  validateProjectedAvailabilityTree(resolved.slot, location);

  if (projectedData !== undefined || displayEvents !== undefined)
    assertProjectionKeysArePlacements(
      collectPlacementIds(resolved.slot),
      projectedData,
      displayEvents,
      location,
    );

  if (controlData !== undefined || controlEvents !== undefined)
    assertControlProjectionKeysArePlacements(
      collectPlacementIds(resolved.slot),
      controlData,
      controlEvents,
      location,
    );

  const applicationTheme = theme ?? ("theme" in composition ? composition.theme : undefined);
  const applicationTokens = applicationTheme?.tokens ?? {};

  const sharedProps = {
    registry,
    location,
    allowEmptyRequiredSlots: resolved.permissionProjected,
    projectedData,
    displayEvents,
    controlData,
    controlEvents,
    themeScope: { application: applicationTokens, inherited: applicationTokens },
  };

  // The theme root serves runtime pages and preview canvases alike; React hoists and
  // de-duplicates the one shared stylesheet however many layouts render.
  return (
    <div {...createThemeRootProps(applicationTheme, themeMode)}>
      <style href="vortex-ui-styles" precedence="default">
        {ALL_UI_STYLES_CSS}
      </style>
      <DateFormatProvider locale={locale} timeZone={timeZone}>
        {breakpoint === undefined ? (
          // Live page: breakpoint-independent HTML plus one responsive stylesheet. The browser
          // provider adopts the visitor's declared child order after load; geometry is pure CSS.
          <LayoutBreakpointProvider>
            <LivePageLayout
              slot={resolved.slot}
              {...sharedProps}
              responsiveStylesheet={collectResponsivePlacementCss(resolved.slot)}
              {...(className === undefined ? {} : { className })}
              {...(style === undefined ? {} : { style })}
            />
          </LayoutBreakpointProvider>
        ) : (
          // Explicit preview breakpoint: one breakpoint rendered with inline geometry.
          <PlacementSlotView
            slot={resolved.slot}
            breakpoint={breakpoint}
            {...sharedProps}
            {...(className === undefined ? {} : { className })}
            {...(style === undefined ? {} : { style })}
          />
        )}
      </DateFormatProvider>
    </div>
  );
}

type LivePageLayoutProps = Omit<PlacementSlotRendererProps, "breakpoint" | "responsive"> &
  Readonly<{ responsiveStylesheet: string }>;

/** Client subscriber that renders the resolved tree in the visitor's breakpoint order. */
function LivePageLayout({ responsiveStylesheet, ...slotProps }: LivePageLayoutProps): ReactElement {
  const breakpoint = useLayoutBreakpoint();
  return (
    <>
      <style>{responsiveStylesheet}</style>
      <PlacementSlotView {...slotProps} breakpoint={breakpoint} responsive />
    </>
  );
}

/**
 * Collects per-breakpoint geometry for every placement in the resolved tree as one stylesheet.
 * It is keyed by stable placement identity, so it is safe when several pages render at once, and
 * the deterministic placement order keeps server and client markup identical.
 */
function collectResponsivePlacementCss(slot: PlacementSlotV2): string {
  const gridContainer = slotDeclaresGridChildren(slot);
  let css = "";
  for (const placementId of Object.keys(slot.placements).sort()) {
    const placement = slot.placements[placementId];
    if (placement === undefined) continue;
    css += computeResponsivePlacementCss(placementId, placement.responsive, {
      gridItem: gridContainer,
    });
    for (const slotKey of Object.keys(placement.slots).sort()) {
      const childSlot = placement.slots[slotKey];
      if (childSlot !== undefined) css += collectResponsivePlacementCss(childSlot);
    }
  }
  return css;
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
  registry?: PlatformComponentRegistry;
}): PlacementSlotV2 {
  return resolveRootPlacementSlotWithContext(options).slot;
}

type ResolvedRootPlacementSlot = Readonly<{
  slot: PlacementSlotV2;
  permissionProjected: boolean;
}>;

const hasCanonicalShellKind = (
  value: unknown,
): value is PageCompositionV2 | GuidedFormPageCompositionV2 =>
  typeof value === "object" && value !== null && "shellKind" in value;

const isCanonicalPageDefinition = (
  value:
    | MaterialisedApplicationCompositionV2
    | PageDefinitionV2
    | PageCompositionV2
    | GuidedFormCompositionV2
    | ProjectedPageCapability,
): value is PageDefinitionV2 =>
  "type" in value &&
  "name" in value &&
  "composition" in value &&
  hasCanonicalShellKind(value.composition);

const requireUniqueShell = (
  shells: readonly ApplicationShellV2[],
  shellId: string,
  pageId?: string,
): ApplicationShellV2 => {
  const matches = shells.filter((candidate) => candidate.shellId === shellId);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new DefinitionRenderError(
      "UNRESOLVED_SHELL",
      `Shell '${shellId}' referenced by page '${pageId ?? "unknown"}' resolved ${matches.length} times`,
      { ...(pageId === undefined ? {} : { pageId }), shellId },
    );
  }
  return matches[0];
};

const resolveGuidedStepId = (
  stepMap: Readonly<Record<string, unknown>>,
  activeStepId: string | undefined,
  orderedSteps: readonly Readonly<{ id: string }>[] | undefined,
  location: DefinitionRenderErrorLocation,
): string => {
  if (orderedSteps !== undefined) {
    const declaredIds = orderedSteps.map((step) => String(step.id));
    const contentIds = Object.keys(stepMap);
    if (
      declaredIds.length === 0 ||
      new Set(declaredIds).size !== declaredIds.length ||
      contentIds.length !== declaredIds.length ||
      contentIds.some((stepId) => !declaredIds.includes(stepId))
    ) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "Guided-step content must match the declared ordered steps exactly once",
        location,
      );
    }
    if (activeStepId !== undefined && !declaredIds.includes(activeStepId)) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Guided step '${activeStepId}' is not in the declared step order`,
        { ...location, stepId: activeStepId },
      );
    }
    const resolved = activeStepId ?? declaredIds[0];
    if (resolved === undefined)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "A guided form must declare at least one ordered step",
        location,
      );
    return resolved;
  }
  if (activeStepId === undefined) {
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "An active guided-step identity is required when the ordered step definition is unavailable",
      location,
    );
  }
  return activeStepId;
};

const validateMaterialisedDependencies = (
  composition: MaterialisedApplicationCompositionV2,
  registry: PlatformComponentRegistry,
): void => {
  const seenBlockIds = new Set<string>();
  for (const dependency of composition.platformBlockDependencies) {
    if (seenBlockIds.has(dependency.blockId)) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Materialised composition repeats platform block dependency '${dependency.blockId}'`,
        { blockId: dependency.blockId, releaseVersion: dependency.releaseVersion },
      );
    }
    seenBlockIds.add(dependency.blockId);
    const registration = registry.get(dependency.blockId, dependency.releaseVersion);
    if (registration === undefined) {
      throw new DefinitionRenderError(
        registry.hasBlockId(dependency.blockId) ? "MISMATCHED_RELEASE" : "UNKNOWN_RELEASE",
        `Materialised composition dependency '${dependency.blockId}:${dependency.releaseVersion}' is unavailable`,
        { blockId: dependency.blockId, releaseVersion: dependency.releaseVersion },
      );
    }
    if (
      registration.metadata.contentFingerprint !== dependency.contentFingerprint ||
      registration.metadata.catalogueFingerprint !== dependency.catalogueFingerprint
    ) {
      throw new DefinitionRenderError(
        "MISMATCHED_RELEASE",
        `Materialised composition dependency '${dependency.blockId}:${dependency.releaseVersion}' does not match registry metadata`,
        { blockId: dependency.blockId, releaseVersion: dependency.releaseVersion },
      );
    }
  }
};

const resolveRootPlacementSlotWithContext = (options: {
  composition:
    | MaterialisedApplicationCompositionV2
    | PageDefinitionV2
    | PageCompositionV2
    | GuidedFormCompositionV2
    | ProjectedPageCapability;
  shells?: readonly ApplicationShellV2[];
  pageId?: string;
  activeStepId?: string;
  registry?: PlatformComponentRegistry;
}): ResolvedRootPlacementSlot => {
  const { composition, pageId, activeStepId, registry } = options;
  const availableShells = [...(options.shells ?? [])];

  // Case 1: MaterialisedApplicationCompositionV2
  if ("pages" in composition && Array.isArray(composition.pages)) {
    if (registry !== undefined) validateMaterialisedDependencies(composition, registry);
    const pageMatches = pageId
      ? composition.pages.filter((page) => page.pageId === pageId)
      : composition.pages.slice(0, 1);
    const targetPage = pageMatches[0];

    if (!targetPage || pageMatches.length !== 1) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Target page '${pageId ?? "default"}' not found in materialised composition`,
        pageId === undefined ? {} : { pageId },
      );
    }

    return {
      slot: resolvePageCompositionSlot({
        composition: targetPage.composition,
        // The materialised composition is authoritative; optional caller shells must not override it.
        shells: composition.shells,
        pageId: targetPage.pageId,
        ...(activeStepId === undefined ? {} : { activeStepId }),
        ...(targetPage.steps === undefined ? {} : { orderedSteps: targetPage.steps }),
        ...(registry === undefined ? {} : { registry }),
      }),
      permissionProjected: false,
    };
  }

  // Case 2: PageDefinitionV2
  if (isCanonicalPageDefinition(composition)) {
    return {
      slot: resolvePageCompositionSlot({
        composition: composition.composition,
        shells: availableShells,
        pageId: composition.pageId,
        ...(activeStepId === undefined ? {} : { activeStepId }),
        ...(composition.type === "guided_form" ? { orderedSteps: composition.steps } : {}),
        ...(registry === undefined ? {} : { registry }),
      }),
      permissionProjected: false,
    };
  }

  // Case 3: ProjectedPageCapability
  if ("composition" in composition) {
    const projectedComp = composition.composition;
    if ("main" in projectedComp) {
      return { slot: projectedComp.main, permissionProjected: true };
    }
    if ("stepContent" in projectedComp) {
      const stepMap = projectedComp.stepContent;
      const stepId = resolveGuidedStepId(
        stepMap,
        activeStepId,
        composition.steps,
        composition.pageId === undefined ? {} : { pageId: composition.pageId },
      );
      const projectedStep = stepMap[stepId];
      if (projectedStep === undefined) {
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Guided step '${activeStepId ?? "first"}' has no projected content`,
          { stepId },
        );
      }
      return { slot: projectedStep, permissionProjected: true };
    }
  }

  // Case 4: Direct PageCompositionV2 | GuidedFormCompositionV2
  if (!hasCanonicalShellKind(composition))
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Unrecognised page composition structure",
      pageId === undefined ? {} : { pageId },
    );
  return {
    slot: resolvePageCompositionSlot({
      composition,
      shells: availableShells,
      ...(pageId === undefined ? {} : { pageId }),
      ...(activeStepId === undefined ? {} : { activeStepId }),
      ...(registry === undefined ? {} : { registry }),
    }),
    permissionProjected: false,
  };
};

function resolvePageCompositionSlot(options: {
  composition: PageCompositionV2 | GuidedFormPageCompositionV2;
  shells: readonly ApplicationShellV2[];
  pageId?: string;
  activeStepId?: string;
  orderedSteps?: readonly Readonly<{ id: string }>[];
  registry?: PlatformComponentRegistry;
}): PlacementSlotV2 {
  const { composition, shells, pageId, activeStepId, orderedSteps, registry } = options;

  // Standard Page with default shell
  if (composition.shellKind === "default" && "main" in composition) {
    return composition.main;
  }

  // Standard Page with application shell
  if (composition.shellKind === "application" && "content" in composition) {
    const shell = requireUniqueShell(shells, composition.shellId, pageId);
    return resolveShellLayout(
      shell,
      composition.content,
      {
        ...(pageId === undefined ? {} : { pageId }),
        shellId: shell.shellId,
      },
      registry,
    );
  }

  // Guided Form with default shell
  if (composition.shellKind === "default" && "stepContent" in composition) {
    const stepMap = composition.stepContent;
    const resolvedStepId = resolveGuidedStepId(
      stepMap,
      activeStepId,
      orderedSteps,
      pageId === undefined ? {} : { pageId },
    );

    const resolvedStep = stepMap[resolvedStepId];
    if (resolvedStep === undefined)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Guided step '${resolvedStepId}' has no step content`,
        { ...(pageId === undefined ? {} : { pageId }), stepId: resolvedStepId },
      );
    return resolvedStep;
  }

  // Guided Form with application shell
  if (composition.shellKind === "application" && "stepContent" in composition) {
    const shell = requireUniqueShell(shells, composition.shellId, pageId);

    const stepMap = composition.stepContent;
    const resolvedStepId = resolveGuidedStepId(stepMap, activeStepId, orderedSteps, {
      ...(pageId === undefined ? {} : { pageId }),
      shellId: shell.shellId,
    });

    const stepSlotContent = stepMap[resolvedStepId];
    if (stepSlotContent === undefined)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Guided step '${resolvedStepId}' has no step content in shell '${shell.shellId}'`,
        {
          ...(pageId === undefined ? {} : { pageId }),
          shellId: shell.shellId,
          stepId: resolvedStepId,
        },
      );
    return resolveShellLayout(
      shell,
      stepSlotContent,
      {
        ...(pageId === undefined ? {} : { pageId }),
        shellId: shell.shellId,
        stepId: resolvedStepId,
      },
      registry,
    );
  }

  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    "Unrecognised page composition structure",
    pageId === undefined ? {} : { pageId },
  );
}

/**
 * Returns the root React element for recursive layout traversal.
 */
export function renderPageLayout(props: PageLayoutRendererProps): ReactElement {
  return <PageLayoutRenderer {...props} />;
}
