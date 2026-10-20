import {
  sourceItemTree,
  sourcePageDataOf,
  sourcePageRootSlots,
  type ApplicationUsePlace,
  type BlockPaletteGroup,
} from "@vortex/platform/schema";
import { PALETTE_GROUP_TITLES } from "../palette-groups";
import {
  cleanName,
  judged,
  quoted,
  refuse,
  uniqueKey,
  type Shell,
  type Source,
  type StudioStructureContext,
  type StudioStructureResult,
} from "./application-structure-common";
import {
  storedItemRelease,
  StoredCompositionRefusal,
  validateStoredApplicationOutlets,
  validateStoredShell,
  validateStoredZone,
} from "./stored-composition";

type Outlet = Shell["content_slots"][number];
export type StudioLayoutOutletValues = Pick<
  Outlet,
  "label" | "required" | "parent_placement" | "parent_slot" | "allowed_child_categories"
>;
export type StudioLayoutOutletCommand =
  | Readonly<{ kind: "add_layout_outlet"; shellAlias: string; values: StudioLayoutOutletValues }>
  | Readonly<{
      kind: "edit_layout_outlet";
      shellAlias: string;
      outletId: string;
      values: StudioLayoutOutletValues;
    }>
  | Readonly<{ kind: "remove_layout_outlet"; shellAlias: string; outletId: string }>;

/** A child category as the palette names it. */
export const studioLayoutOutletCategoryLabel = (category: BlockPaletteGroup): string =>
  PALETTE_GROUP_TITLES[category];

/** Only fixed, empty slots of this shell can reserve page content. */
export const studioLayoutOutletTargets = (
  context: Pick<StudioStructureContext, "catalogue" | "describePlacement">,
  shell: Shell,
  outletId?: string,
) =>
  sourceItemTree(shell.layout.content).flatMap((item, index) => {
    const release = storedItemRelease(context.catalogue, item);
    if (release === undefined) return [];
    const label =
      context.describePlacement({
        block: item.props.vortex.block,
        settings: Object.fromEntries(
          Object.entries(item.props).filter(
            ([key, value]) => key !== "id" && key !== "vortex" && !Array.isArray(value),
          ),
        ),
      }) ?? release.name;
    return release.slots.flatMap((slot) => {
      const children = item.props[slot.key];
      if (
        slot.repeats !== undefined ||
        (children !== undefined && (!Array.isArray(children) || children.length > 0)) ||
        shell.content_slots.some(
          (outlet) =>
            outlet.id !== outletId &&
            outlet.parent_placement === item.props.id &&
            outlet.parent_slot === slot.key,
        )
      )
        return [];
      return [
        {
          parentPlacement: item.props.id,
          parentSlot: slot.key,
          label: `${label} ${index + 1} / ${slot.label}`,
          categories: slot.allowedChildCategories,
          /** The catalogue slot always needs content, so an outlet on it is always Required. */
          required: slot.required,
        },
      ];
    });
  });

const pageUse = (page: Source["body"]["pages"][number]): ApplicationUsePlace => ({
  label: `Page ${quoted(page.name)}`,
  open: { kind: "page", pageAlias: page.id },
});

/** Outlets reserved inside a selected block or any descendant, and their bound pages. */
export const studioLayoutOutletPlacementUses = (
  source: Source,
  placementAlias: string,
): readonly ApplicationUsePlace[] => {
  for (const shell of source.body.shells) {
    const item = sourceItemTree(shell.layout.content).find(
      (entry) => entry.props.id === placementAlias,
    );
    if (item === undefined) continue;
    const subtree = new Set(sourceItemTree([item]).map((entry) => entry.props.id));
    const outlets = shell.content_slots.filter((outlet) => subtree.has(outlet.parent_placement));
    if (outlets.length === 0) return [];
    return [
      ...outlets.map((outlet): ApplicationUsePlace => ({
        label: `Content outlet ${quoted(outlet.label)} in layout ${quoted(shell.name)}`,
        open: { kind: "shell", shellAlias: shell.id },
      })),
      ...source.body.pages
        .filter((page) =>
          sourcePageDataOf(page.composition).some(
            (data) =>
              data.root.props.vortex.shell === shell.id &&
              outlets.some((outlet) => Object.hasOwn(data.root.props, outlet.id)),
          ),
        )
        .map(pageUse),
    ];
  }
  return [];
};

/** One atomic edit of the existing shell and the pages that bind it. Never creates page blocks. */
export const editLayoutOutlet = (
  context: StudioStructureContext,
  candidate: Source,
  command: StudioLayoutOutletCommand,
): StudioStructureResult => {
  const shell = candidate.body.shells.find((entry) => entry.id === command.shellAlias);
  if (shell === undefined) return refuse("That layout is no longer in the draft.");
  const pages = candidate.body.pages.filter((page) =>
    sourcePageDataOf(page.composition).some((data) => data.root.props.vortex.shell === shell.id),
  );
  const existing =
    command.kind === "add_layout_outlet"
      ? undefined
      : shell.content_slots.find((entry) => entry.id === command.outletId);
  if (command.kind !== "add_layout_outlet" && existing === undefined)
    return refuse("That content outlet is no longer in this layout.");
  if (command.kind === "remove_layout_outlet") {
    const uses = pages.filter((page) =>
      sourcePageDataOf(page.composition).some(
        (data) =>
          data.root.props.vortex.shell === shell.id &&
          sourcePageRootSlots(data).some(([id, items]) => id === existing!.id && items.length > 0),
      ),
    );
    if (uses.length > 0)
      return refuse(
        `The outlet ${quoted(existing!.label)} holds blocks on these pages. Move or remove those blocks first.`,
        uses.map(pageUse),
      );
    if (shell.content_slots.length === 1)
      return refuse(
        "A layout needs at least one content outlet. Add another before removing this one.",
      );
    shell.content_slots = shell.content_slots.filter((entry) => entry.id !== existing!.id);
    // Empty bindings hold no content; they leave with the outlet, so no page keeps a dangling one.
    for (const page of pages)
      for (const data of sourcePageDataOf(page.composition))
        if (data.root.props.vortex.shell === shell.id) {
          delete data.root.props[existing!.id];
          delete data.root.props.vortex.slot_orders[existing!.id];
        }
  } else {
    const values = command.values;
    const target = studioLayoutOutletTargets(context, shell, existing?.id).find(
      (entry) =>
        entry.parentPlacement === values.parent_placement &&
        entry.parentSlot === values.parent_slot,
    );
    if (target === undefined)
      return refuse("Choose an empty, unexposed catalogue slot in this layout.");
    const placement = sourceItemTree(shell.layout.content).find(
      (item) => item.props.id === target.parentPlacement,
    )!;
    // Optional fixed slots need not already be authored. Reserving one writes its empty array.
    if (placement.props[target.parentSlot] === undefined) placement.props[target.parentSlot] = [];
    if (
      values.allowed_child_categories.length === 0 ||
      new Set(values.allowed_child_categories).size !== values.allowed_child_categories.length ||
      values.allowed_child_categories.some((category) => !target.categories.includes(category))
    )
      return refuse("Choose at least one distinct category allowed by the target slot.");
    if (target.required && !values.required)
      return refuse(
        "This target always needs page content, so its outlet must stay Required. Choose another target to make it optional.",
      );
    const label = cleanName(values.label, "content outlet");
    const outlet: Outlet =
      existing === undefined
        ? {
            ...values,
            label,
            id: uniqueKey(
              label,
              "slot_",
              new Set(
                candidate.body.shells.flatMap((entry) =>
                  entry.content_slots.map((slot) => slot.id),
                ),
              ),
              160,
            ),
            key: uniqueKey(label, "", new Set(shell.content_slots.map((slot) => slot.key)), 40),
          }
        : { ...values, label, id: existing.id, key: existing.key };
    const incompatible = pages.filter((page) =>
      sourcePageDataOf(page.composition).some(
        (data) =>
          data.root.props.vortex.shell === shell.id &&
          sourcePageRootSlots(data).some(
            ([id, items]) =>
              id === outlet.id &&
              items.some((item) => {
                const release = storedItemRelease(context.catalogue, item);
                return (
                  release === undefined ||
                  !outlet.allowed_child_categories.includes(release.paletteGroup)
                );
              }),
          ),
      ),
    );
    if (incompatible.length > 0)
      return refuse(
        `The outlet ${quoted(label)} cannot admit the existing blocks on these pages. Move the blocks or allow their categories first.`,
        incompatible.map(pageUse),
      );
    if (existing === undefined) shell.content_slots.push(outlet);
    else shell.content_slots[shell.content_slots.indexOf(existing)] = outlet;
    // The existing composition helper includes every guided step. Binding presence, even empty,
    // satisfies Required. Keep existing arrays and breakpoint orders byte-for-byte on retarget.
    if (outlet.required || existing === undefined)
      for (const page of pages)
        for (const data of sourcePageDataOf(page.composition)) {
          if (
            data.root.props.vortex.shell === shell.id &&
            !Object.hasOwn(data.root.props, outlet.id)
          )
            data.root.props[outlet.id] = [];
        }
  }
  try {
    validateStoredShell(context.catalogue, shell);
    validateStoredApplicationOutlets(context.catalogue, candidate);
    for (const page of pages)
      for (const data of sourcePageDataOf(page.composition)) {
        for (const [id, items] of sourcePageRootSlots(data)) {
          validateStoredZone(context.catalogue, {
            items,
            order: data.root.props.vortex.slot_orders[id],
          });
        }
      }
  } catch (error) {
    if (!(error instanceof StoredCompositionRefusal)) throw error;
    return refuse(
      `The layout or its page content would be invalid: ${error.message}.`,
      pages.map(pageUse),
      { part: error.location.join("."), reason: error.reason },
    );
  }
  return {
    kind: "applied",
    source: judged(candidate),
    select: { kind: "shell", shellAlias: shell.id },
    details: [],
    message: "Content outlets updated.",
  };
};
