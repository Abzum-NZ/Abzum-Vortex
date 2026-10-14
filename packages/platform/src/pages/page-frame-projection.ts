import type { ApplicationShell } from "../definition/application-composition/page-composition";

type PlacementSlot = ApplicationShell["layout"];
type JsonObject = Record<string, unknown>;

/**
 * Where the page content sits inside the application frame. A shell with one content slot holds
 * the content in that slot. Several content slots are held by their nearest common placement, which
 * then belongs to the page. Without a common placement (or without a shell) the whole root is the
 * content. The frame renders one outlet at this location and the page fills it.
 */
export type ShellOutletLocation =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "slot"; placementId: string; slotKey: string }>
  | Readonly<{ kind: "placement"; placementId: string }>;

/** The viewer's application frame: the projected shell without the page content. */
export type ProjectedApplicationFrame = Readonly<{
  shellId?: string;
  composition: Readonly<{ main: PlacementSlot }>;
  outlet: ShellOutletLocation;
}>;

/** One projected page split into the frame around it and the content it places in the outlet. */
export type SplitProjectedPage = Readonly<{
  frame: ProjectedApplicationFrame;
  content: Readonly<Record<string, unknown>>;
}>;

const object = (value: unknown): JsonObject => value as JsonObject;

const emptySlot = (): PlacementSlot => ({
  placements: {},
  order: { desktop: [], tablet: [], phone: [] },
});

/** Ancestor placement identities from the root down to and including the named placement. */
const pathTo = (slot: PlacementSlot, placementId: string): readonly string[] | undefined => {
  for (const [id, placement] of Object.entries(slot.placements)) {
    if (id === placementId) return [id];
    for (const child of Object.values(placement.slots)) {
      const nested = pathTo(child, placementId);
      if (nested !== undefined) return [id, ...nested];
    }
  }
  return undefined;
};

/** The outlet location a shell declares through its content slots. */
export const shellOutletLocation = (shell: ApplicationShell | undefined): ShellOutletLocation => {
  if (shell === undefined || shell.contentSlots.length === 0) return { kind: "root" };
  const [first, ...rest] = shell.contentSlots;
  if (first !== undefined && rest.length === 0)
    return {
      kind: "slot",
      placementId: String(first.parentPlacementId),
      slotKey: first.parentSlotKey,
    };
  const paths = shell.contentSlots.map((binding) => pathTo(shell.layout, String(binding.parentPlacementId)));
  if (paths.some((path) => path === undefined)) return { kind: "root" };
  const [head, ...others] = paths as readonly (readonly string[])[];
  let common = 0;
  while (
    head !== undefined &&
    common < head.length &&
    others.every((path) => path[common] === head[common])
  )
    common += 1;
  const placementId = head?.[common - 1];
  return placementId === undefined ? { kind: "root" } : { kind: "placement", placementId };
};

/** Locates a placement and the slot that holds it in a projected slot tree. */
const locate = (
  slot: JsonObject,
  placementId: string,
): Readonly<{ parent: JsonObject; placement: JsonObject }> | undefined => {
  const placements = object(slot.placements);
  const direct = placements[placementId];
  if (direct !== undefined) return { parent: slot, placement: object(direct) };
  for (const placement of Object.values(placements))
    for (const child of Object.values(object(object(placement).slots))) {
      const found = locate(object(child), placementId);
      if (found !== undefined) return found;
    }
  return undefined;
};

const splitRoot = (
  root: unknown,
  outlet: ShellOutletLocation,
): Readonly<{ frame: PlacementSlot; content: JsonObject }> => {
  if (outlet.kind === "root") return { frame: emptySlot(), content: object(root) };
  const frame = structuredClone(object(root));
  const found = locate(frame, outlet.placementId);
  if (found === undefined)
    // The viewer may not see the placement that holds the content, so no content is shown, exactly
    // as when the content is composed into that placement.
    return { frame: frame as PlacementSlot, content: emptySlot() };
  if (outlet.kind === "slot") {
    const slots = object(found.placement.slots);
    const content = object(slots[outlet.slotKey] ?? emptySlot());
    slots[outlet.slotKey] = emptySlot();
    return { frame: frame as PlacementSlot, content };
  }
  const original = locate(object(root), outlet.placementId);
  const order = object(found.parent.order);
  const content = {
    placements: { [outlet.placementId]: structuredClone(original?.placement) },
    order: Object.fromEntries(
      Object.entries(order).map(([breakpoint, ids]) => [
        breakpoint,
        (ids as readonly string[]).filter((id) => id === outlet.placementId),
      ]),
    ),
  };
  // The frame keeps the holding placement's position, emptied, so the outlet takes its place.
  for (const key of Object.keys(object(found.placement.slots)))
    object(found.placement.slots)[key] = emptySlot();
  return { frame: frame as PlacementSlot, content };
};

/**
 * Splits one permission-projected page into its application frame and its content. Both parts come
 * from the same projection, so the frame carries exactly the shell placements the viewer was
 * allowed on this page and the content carries exactly the page's own placements; nothing is
 * decided again.
 */
export const splitProjectedPage = (
  projected: Readonly<Record<string, unknown>>,
  shell: ApplicationShell | undefined,
): SplitProjectedPage => {
  const outlet = shellOutletLocation(shell);
  const composition = object(projected.composition);
  // The content renders inside the frame's outlet, so it names no shell of its own.
  const page = Object.fromEntries(Object.entries(projected).filter(([key]) => key !== "shellId"));
  if ("main" in composition) {
    const { frame, content } = splitRoot(composition.main, outlet);
    return {
      frame: {
        ...(shell === undefined ? {} : { shellId: String(shell.shellId) }),
        composition: { main: frame },
        outlet,
      },
      content: { ...page, composition: { main: content } },
    };
  }
  const stepContent = object(composition.stepContent);
  const steps = Object.entries(stepContent).map(
    ([stepId, root]) => [stepId, splitRoot(root, outlet)] as const,
  );
  const frame = steps[0]?.[1].frame ?? emptySlot();
  return {
    frame: {
      ...(shell === undefined ? {} : { shellId: String(shell.shellId) }),
      composition: { main: frame },
      outlet,
    },
    content: {
      ...page,
      composition: {
        stepContent: Object.fromEntries(steps.map(([stepId, split]) => [stepId, split.content])),
      },
    },
  };
};
