import type {
  BlockCapabilitiesV2,
  BlockPlacementV2Contract,
  BlockPropertyValueV2Contract,
  PlatformBlockReleaseV2,
} from "@vortex/contracts";
import type { PlatformComponentRegistry } from "./registry";

export type Breakpoint = "desktop" | "tablet" | "phone";

export type DefinitionRenderErrorCode =
  | "UNKNOWN_RELEASE"
  | "MISMATCHED_RELEASE"
  | "ABSENT_RENDERER_KEY"
  | "UNDECLARED_CHILDREN"
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
  capabilities: BlockCapabilitiesV2,
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

  let currentSettings: Record<string, BlockPropertyValueV2Contract> = settings;
  let targetValue: BlockPropertyValueV2Contract | undefined;

  for (let index = 0; index < propertyPath.length; index++) {
    const key = propertyPath[index]!;
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
): void {
  const declaredSlots = new Map(metadata.slots.map((slot) => [slot.key, slot]));

  for (const slotKey of Object.keys(placement.slots)) {
    const declaration = declaredSlots.get(slotKey);
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
