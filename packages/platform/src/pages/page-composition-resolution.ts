import type { ApplicationShell } from "../definition/application-composition/page-composition";
import type { PageDefinition } from "../definition/application-contracts";

export type PlacementSlot = ApplicationShell["layout"];
export type ResolvedPageComposition = Readonly<{
  page: PageDefinition;
  roots:
    | Readonly<{ kind: "page"; main: PlacementSlot }>
    | Readonly<{ kind: "guided"; stepContent: Readonly<Record<string, PlacementSlot>> }>;
}>;

const emptySlot = (): PlacementSlot => ({
  placements: {},
  order: { desktop: [], tablet: [], phone: [] },
});

const cloneSlot = (slot: PlacementSlot): PlacementSlot => ({
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
});

const findPlacement = (
  slot: PlacementSlot,
  placementId: string,
): PlacementSlot["placements"][string] | undefined => {
  const direct = slot.placements[placementId];
  if (direct !== undefined) return direct;
  for (const placement of Object.values(slot.placements))
    for (const child of Object.values(placement.slots)) {
      const found = findPlacement(child, placementId);
      if (found !== undefined) return found;
    }
  return undefined;
};

const collectUniquePlacementIds = (slot: PlacementSlot, ids: Set<string>): void => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    if (ids.has(placementId)) throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
    ids.add(placementId);
    for (const child of Object.values(placement.slots)) collectUniquePlacementIds(child, ids);
  }
};

const requireUniquePlacementOwnership = (
  shell: ApplicationShell | undefined,
  pageSlots: readonly PlacementSlot[],
): void => {
  const ids = new Set<string>();
  if (shell !== undefined) collectUniquePlacementIds(shell.layout, ids);
  for (const slot of pageSlots) collectUniquePlacementIds(slot, ids);
};

const resolvedShellRoot = (
  shell: ApplicationShell,
  content: Readonly<Record<string, PlacementSlot>>,
): PlacementSlot => {
  const allowed = new Set(shell.contentSlots.map((slot) => String(slot.slotId)));
  if (Object.keys(content).some((slotId) => !allowed.has(slotId)))
    throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
  const root = cloneSlot(shell.layout);
  for (const binding of shell.contentSlots) {
    const supplied = content[String(binding.slotId)];
    if (
      binding.required &&
      (supplied === undefined || Object.keys(supplied.placements).length === 0)
    )
      throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
    const parent = findPlacement(root, String(binding.parentPlacementId));
    const reserved = parent?.slots[binding.parentSlotKey];
    if (
      parent === undefined ||
      reserved === undefined ||
      Object.keys(reserved.placements).length > 0 ||
      reserved.order.desktop.length > 0 ||
      reserved.order.tablet.length > 0 ||
      reserved.order.phone.length > 0
    )
      throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
    parent.slots[binding.parentSlotKey] = cloneSlot(supplied ?? emptySlot());
  }
  return root;
};

export const resolvePageComposition = (
  page: PageDefinition,
  shells: readonly ApplicationShell[] = [],
): ResolvedPageComposition => {
  const composition = page.composition;
  if (composition.shellKind === "default") {
    requireUniquePlacementOwnership(
      undefined,
      "main" in composition ? [composition.main] : Object.values(composition.stepContent),
    );
    return "main" in composition
      ? { page, roots: { kind: "page", main: composition.main } }
      : { page, roots: { kind: "guided", stepContent: composition.stepContent } };
  }

  const matches = shells.filter((shell) => shell.shellId === composition.shellId);
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error("PAGE_COMPOSITION_SHELL_UNAVAILABLE");
  const shell = matches[0];
  if ("content" in composition) {
    requireUniquePlacementOwnership(shell, Object.values(composition.content));
    return {
      page,
      roots: { kind: "page", main: resolvedShellRoot(shell, composition.content) },
    };
  }

  const expectedSteps =
    page.type === "guided_form" ? page.steps.map((step) => String(step.id)) : [];
  const stepContent = composition.stepContent as unknown as Record<
    string,
    Record<string, PlacementSlot>
  >;
  if (
    Object.keys(stepContent).length !== expectedSteps.length ||
    expectedSteps.some((stepId) => stepContent[stepId] === undefined)
  )
    throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
  requireUniquePlacementOwnership(
    shell,
    Object.values(stepContent).flatMap((content) => Object.values(content)),
  );
  return {
    page,
    roots: {
      kind: "guided",
      stepContent: Object.fromEntries(
        expectedSteps.map((stepId) => [stepId, resolvedShellRoot(shell, stepContent[stepId]!)]),
      ),
    },
  };
};
