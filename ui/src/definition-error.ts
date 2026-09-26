import {
  repeatableSlotItemIdentitiesV2,
  repeatableSlotKeyV2,
  type ApplicationShellV2,
  type BlockPlacementV2Contract,
  type BlockPropertyValueV2Contract,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";
import type { PlatformComponentRegistry } from "./registry";

export type Breakpoint = "desktop" | "tablet" | "phone";

export type DefinitionRenderErrorCode =
  | "UNKNOWN_RELEASE"
  | "MISMATCHED_RELEASE"
  | "ABSENT_RENDERER_KEY"
  | "RENDERER_KEY_CONFLICT"
  | "UNDECLARED_CHILDREN"
  | "MISSING_CHILDREN"
  | "ILLEGAL_CHILDREN"
  | "INCOMPLETE_CHILD_ORDERING"
  | "MISSING_ACCESSIBLE_NAME"
  | "BLANK_ACCESSIBLE_NAME"
  | "UNRESOLVED_SHELL"
  | "INVALID_COMPOSITION";

export type DefinitionRenderErrorLocation = Readonly<{
  pageId?: string;
  stepId?: string;
  shellId?: string;
  placementId?: string;
  blockId?: string;
  releaseVersion?: string;
  slotKey?: string;
  childPlacementId?: string;
  breakpoint?: Breakpoint;
  propertyPath?: readonly string[];
}>;

/**
 * Located definition/render error representing a contract violation or metadata mismatch.
 * Fails closed and prevents fallback to arbitrary output.
 */
export class DefinitionRenderError extends Error {
  readonly code: DefinitionRenderErrorCode;
  readonly location: DefinitionRenderErrorLocation;

  constructor(
    code: DefinitionRenderErrorCode,
    message: string,
    location: DefinitionRenderErrorLocation = {},
  ) {
    super(message);
    this.name = "DefinitionRenderError";
    this.code = code;
    this.location = Object.freeze({ ...location });
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      location: this.location,
    };
  }
}

/**
 * Validates that a required accessible name exists and is not blank,
 * or that an optional accessible name is not blank if provided.
 */
export function validateAccessibleName(
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>,
  capabilities: PlatformBlockReleaseV2["capabilities"],
  location: DefinitionRenderErrorLocation = {},
): void {
  if (capabilities.accessibleName === "not_applicable") {
    return;
  }

  const propertyPath = capabilities.accessibleNamePropertyPath;
  if (!propertyPath || propertyPath.length === 0) {
    if (capabilities.accessibleName === "required") {
      throw new DefinitionRenderError(
        "MISSING_ACCESSIBLE_NAME",
        "Required accessible name property path is not declared",
        { ...location, propertyPath },
      );
    }
    return;
  }

  let currentSettings: Readonly<Record<string, BlockPropertyValueV2Contract>> = settings;
  let targetValue: BlockPropertyValueV2Contract | undefined;

  for (const [index, key] of propertyPath.entries()) {
    const val = currentSettings[key];
    if (val === undefined) {
      targetValue = undefined;
      break;
    }
    if (index === propertyPath.length - 1) {
      targetValue = val;
    } else {
      if (val.kind !== "group") {
        throw new DefinitionRenderError(
          "MISSING_ACCESSIBLE_NAME",
          `Accessible name path segment '${key}' must target a group property`,
          { ...location, propertyPath },
        );
      }
      currentSettings = val.properties;
    }
  }

  if (targetValue === undefined) {
    if (capabilities.accessibleName === "required") {
      throw new DefinitionRenderError(
        "MISSING_ACCESSIBLE_NAME",
        `Required accessible name is missing at path '${propertyPath.join(".")}'`,
        { ...location, propertyPath },
      );
    }
    return;
  }

  if (targetValue.kind !== "text") {
    throw new DefinitionRenderError(
      "MISSING_ACCESSIBLE_NAME",
      `Accessible name property at path '${propertyPath.join(".")}' must be a text kind`,
      { ...location, propertyPath },
    );
  }

  if (targetValue.value.trim().length === 0) {
    throw new DefinitionRenderError(
      "BLANK_ACCESSIBLE_NAME",
      `Accessible name at path '${propertyPath.join(".")}' must not be blank`,
      { ...location, propertyPath },
    );
  }
}

/**
 * Validates that each declared breakpoint order contains exactly the set of placement IDs
 * declared in slot.placements (complete permutation, no missing, extra, or duplicate IDs).
 */
export function validateSlotOrder(
  slot: {
    placements: Readonly<Record<string, unknown>>;
    order: Readonly<{
      desktop?: readonly string[];
      tablet?: readonly string[];
      phone?: readonly string[];
    }>;
  },
  breakpoint: Breakpoint,
  location: DefinitionRenderErrorLocation = {},
): readonly string[] {
  const declaredPlacementIds = Object.keys(slot.placements);
  const orderList = slot.order?.[breakpoint];

  if (!Array.isArray(orderList)) {
    throw new DefinitionRenderError(
      "INCOMPLETE_CHILD_ORDERING",
      `Missing child order list for breakpoint '${breakpoint}'`,
      { ...location, breakpoint },
    );
  }

  if (orderList.length !== declaredPlacementIds.length) {
    throw new DefinitionRenderError(
      "INCOMPLETE_CHILD_ORDERING",
      `Child order length (${orderList.length}) for breakpoint '${breakpoint}' does not match placements count (${declaredPlacementIds.length})`,
      { ...location, breakpoint },
    );
  }

  const seen = new Set<string>();
  for (const id of orderList) {
    if (seen.has(id)) {
      throw new DefinitionRenderError(
        "INCOMPLETE_CHILD_ORDERING",
        `Duplicate placement ID '${id}' in child order for breakpoint '${breakpoint}'`,
        { ...location, breakpoint, childPlacementId: id },
      );
    }
    seen.add(id);
    if (!slot.placements[id]) {
      throw new DefinitionRenderError(
        "INCOMPLETE_CHILD_ORDERING",
        `Placement ID '${id}' in child order for breakpoint '${breakpoint}' is not declared in slot placements`,
        { ...location, breakpoint, childPlacementId: id },
      );
    }
  }

  for (const id of declaredPlacementIds) {
    if (!seen.has(id)) {
      throw new DefinitionRenderError(
        "INCOMPLETE_CHILD_ORDERING",
        `Declared placement ID '${id}' is missing from child order for breakpoint '${breakpoint}'`,
        { ...location, breakpoint, childPlacementId: id },
      );
    }
  }

  return orderList;
}

/**
 * Validates child slots and category restrictions:
 * 1. Placement slots must only contain keys declared in metadata.slots.
 * 2. Child placements within each slot must have a paletteGroup permitted by allowedChildCategories.
 */
export function validatePlacementSlots(
  placement: BlockPlacementV2Contract,
  metadata: PlatformBlockReleaseV2,
  registry: PlatformComponentRegistry,
  location: DefinitionRenderErrorLocation = {},
  options: Readonly<{ allowEmptyRequiredSlots?: boolean }> = {},
): void {
  // A repeatable declaration's own key names only its family, never a slot.
  const declaredSlots = new Map(
    metadata.slots.filter((slot) => slot.repeats === undefined).map((slot) => [slot.key, slot]),
  );

  // A repeatable slot owns one key per declared item identity, so resolve every item's own key to
  // its declaration before judging the placement's slots.
  const repeatableSlots = new Map<string, PlatformBlockReleaseV2["slots"][number]>();
  for (const declaration of metadata.slots) {
    if (declaration.repeats === undefined) continue;
    for (const identity of repeatableSlotItemIdentitiesV2(declaration, placement.settings))
      repeatableSlots.set(repeatableSlotKeyV2(declaration.key, identity), declaration);
  }

  for (const declaration of metadata.slots) {
    if (declaration.repeats !== undefined) continue;
    const childSlot = placement.slots[declaration.key];
    if (
      declaration.required &&
      (childSlot === undefined ||
        (!options.allowEmptyRequiredSlots && Object.keys(childSlot.placements).length === 0))
    ) {
      throw new DefinitionRenderError(
        "MISSING_CHILDREN",
        `Required child slot '${declaration.key}' on block '${metadata.key}' (${metadata.blockId}) has no content`,
        { ...location, slotKey: declaration.key },
      );
    }
  }

  for (const slotKey of Object.keys(placement.slots)) {
    const declaration = declaredSlots.get(slotKey) ?? repeatableSlots.get(slotKey);
    if (!declaration) {
      throw new DefinitionRenderError(
        "UNDECLARED_CHILDREN",
        `Undeclared child slot '${slotKey}' on block '${metadata.key}' (${metadata.blockId})`,
        { ...location, slotKey },
      );
    }

    const slot = placement.slots[slotKey];
    if (!slot) continue;

    const allowedCategories = new Set(declaration.allowedChildCategories);

    for (const [childId, childPlacement] of Object.entries(slot.placements)) {
      const childRegistration = registry.get(
        childPlacement.block.blockId,
        childPlacement.block.releaseVersion,
      );

      if (!childRegistration) {
        if (registry.hasBlockId(childPlacement.block.blockId)) {
          throw new DefinitionRenderError(
            "MISMATCHED_RELEASE",
            `Child placement '${childId}' references mismatched block release version '${childPlacement.block.releaseVersion}' for block '${childPlacement.block.blockId}'`,
            {
              ...location,
              slotKey,
              childPlacementId: childId,
              blockId: childPlacement.block.blockId,
              releaseVersion: childPlacement.block.releaseVersion,
            },
          );
        }
        throw new DefinitionRenderError(
          "UNKNOWN_RELEASE",
          `Child placement '${childId}' references unknown block '${childPlacement.block.blockId}' release '${childPlacement.block.releaseVersion}'`,
          {
            ...location,
            slotKey,
            childPlacementId: childId,
            blockId: childPlacement.block.blockId,
            releaseVersion: childPlacement.block.releaseVersion,
          },
        );
      }

      const childMetadata = childRegistration.metadata;
      if (!allowedCategories.has(childMetadata.paletteGroup)) {
        throw new DefinitionRenderError(
          "ILLEGAL_CHILDREN",
          `Child block '${childMetadata.key}' with category '${childMetadata.paletteGroup}' is not allowed in slot '${slotKey}'. Allowed categories: ${Array.from(allowedCategories).join(", ")}`,
          {
            ...location,
            slotKey,
            childPlacementId: childId,
            blockId: childMetadata.blockId,
            releaseVersion: childMetadata.releaseVersion,
          },
        );
      }
    }
  }
}

/**
 * Validates a complete placement tree before any registered renderer is invoked.
 * Permission projection may legitimately empty a required slot after publication validation.
 */
export function validatePlacementTree(
  slot: ApplicationShellV2["layout"],
  registry: PlatformComponentRegistry,
  location: DefinitionRenderErrorLocation = {},
  options: Readonly<{ allowEmptyRequiredSlots?: boolean }> = {},
): void {
  const seenPlacementIds = new Set<string>();

  const visit = (
    currentSlot: ApplicationShellV2["layout"],
    currentLocation: DefinitionRenderErrorLocation,
  ): void => {
    for (const breakpoint of ["desktop", "tablet", "phone"] as const)
      validateSlotOrder(currentSlot, breakpoint, currentLocation);

    for (const [placementId, placement] of Object.entries(currentSlot.placements)) {
      const placementLocation: DefinitionRenderErrorLocation = {
        ...currentLocation,
        placementId,
        blockId: placement.block.blockId,
        releaseVersion: placement.block.releaseVersion,
      };
      if (seenPlacementIds.has(placementId)) {
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Placement identity '${placementId}' appears more than once in the rendered tree`,
          placementLocation,
        );
      }
      seenPlacementIds.add(placementId);

      const registration = registry.get(
        placement.block.blockId,
        placement.block.releaseVersion,
      );
      if (registration === undefined) {
        throw new DefinitionRenderError(
          registry.hasBlockId(placement.block.blockId) ? "MISMATCHED_RELEASE" : "UNKNOWN_RELEASE",
          `Placement '${placementId}' references ${
            registry.hasBlockId(placement.block.blockId) ? "mismatched" : "unknown"
          } block release '${placement.block.blockId}:${placement.block.releaseVersion}'`,
          placementLocation,
        );
      }

      const keyedRenderer = registry.getRenderer(registration.metadata.rendererKey);
      if (keyedRenderer === undefined || keyedRenderer !== registration.render) {
        throw new DefinitionRenderError(
          "RENDERER_KEY_CONFLICT",
          `Renderer key '${registration.metadata.rendererKey}' does not resolve to the exact registered renderer`,
          placementLocation,
        );
      }

      validateAccessibleName(placement.settings, registration.metadata.capabilities, placementLocation);
      validatePlacementSlots(
        placement,
        registration.metadata,
        registry,
        placementLocation,
        options,
      );

      const layouts = [
        placement.responsive.desktop,
        placement.responsive.tablet,
        placement.responsive.phone,
      ];
      if (
        !registration.metadata.capabilities.responsiveVisibility &&
        layouts.some((layout) => layout.visible !== layouts[0]?.visible)
      ) {
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Block '${registration.metadata.key}' does not permit responsive visibility overrides`,
          placementLocation,
        );
      }
      if (
        !registration.metadata.capabilities.gridWidth &&
        layouts.some((layout) => layout.width.kind === "grid")
      ) {
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Block '${registration.metadata.key}' does not permit grid-width placement`,
          placementLocation,
        );
      }
      if (
        registration.metadata.capabilities.height === "content" &&
        layouts.some((layout) => layout.height.kind !== "content")
      ) {
        throw new DefinitionRenderError(
          "INVALID_COMPOSITION",
          `Block '${registration.metadata.key}' permits content-driven height only`,
          placementLocation,
        );
      }
      if (!registration.metadata.capabilities.responsiveOrder) {
        for (const [slotKey, childSlot] of Object.entries(placement.slots)) {
          const desktopOrder = childSlot.order.desktop;
          if (
            childSlot.order.tablet.some((entry, index) => entry !== desktopOrder[index]) ||
            childSlot.order.phone.some((entry, index) => entry !== desktopOrder[index])
          ) {
            throw new DefinitionRenderError(
              "INCOMPLETE_CHILD_ORDERING",
              `Block '${registration.metadata.key}' does not permit responsive child-order overrides`,
              { ...placementLocation, slotKey },
            );
          }
        }
      }

      for (const [slotKey, childSlot] of Object.entries(placement.slots))
        visit(childSlot, { ...placementLocation, slotKey });
    }
  };

  visit(slot, location);
}
