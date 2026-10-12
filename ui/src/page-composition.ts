import type {
  ApplicationContentV2,
  ApplicationShellV2,
  BlockPlacementV2Contract,
  GuidedFormPageCompositionV2,
  PageCompositionV2,
  PageDefinitionV2,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "./definition-error";
import { projectedAvailability } from "./placement-availability";
import type { PlatformComponentRegistry } from "./registry";
import type { ApplicationThemeV2 } from "./theme";

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

export const validateProjectedAvailabilityTree = (
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

export const validatePlacementDependencies = (
  slot: PlacementSlotV2,
  dependencies: ApplicationContentV2["platformBlockDependencies"],
  location: DefinitionRenderErrorLocation,
): void => {
  const releases = new Set(
    dependencies.map((dependency) => `${dependency.blockId}@${dependency.releaseVersion}`),
  );
  const visit = (
    current: PlacementSlotV2,
    currentLocation: DefinitionRenderErrorLocation,
  ): void => {
    for (const [placementId, placement] of Object.entries(current.placements)) {
      const placementLocation = {
        ...currentLocation,
        placementId,
        blockId: placement.block.blockId,
        releaseVersion: placement.block.releaseVersion,
      };
      if (!releases.has(`${placement.block.blockId}@${placement.block.releaseVersion}`)) {
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

    if (binding.required && (!supplied || Object.keys(supplied.placements).length === 0)) {
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
  const seenBlockReleases = new Set<string>();
  for (const dependency of composition.platformBlockDependencies) {
    const identity = `${dependency.blockId}@${dependency.releaseVersion}`;
    if (seenBlockReleases.has(identity)) {
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        `Materialised composition repeats platform block dependency '${identity}'`,
        { blockId: dependency.blockId, releaseVersion: dependency.releaseVersion },
      );
    }
    seenBlockReleases.add(identity);
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

    const resolvedStep = stepMap[resolvedStepId as keyof typeof stepMap];
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

    const stepSlotContent = stepMap[resolvedStepId as keyof typeof stepMap];
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
