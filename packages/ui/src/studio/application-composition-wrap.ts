import {
  applicationSourceDocumentSchema,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import { PALETTE_GROUP_TITLES } from "../palette-groups";
import {
  StoredCompositionRefusal,
  syncStoredBlockDependencies,
  validateStoredApplicationOutlets,
} from "./stored-composition";
import type { StudioSemanticSelection } from "./semantic-selection";
import type { StudioPaletteChoice } from "./contextual-palette";
import type {
  StudioCompositionContext,
  StudioCompositionOwner,
  StudioCompositionWrapModel,
  StudioCompositionCommandResult,
} from "./application-composition-model";
import {
  type Region,
  toolsFor,
  releaseFor,
  holdsForm,
  FORM_CONTAINER_KEY,
  NESTED_FORM_REASON,
  pinnedRelease,
  manifestMatches,
  resolve,
  sameSteps,
  closedPlain,
  workingCopy,
  zoneHandle,
  commitWorking,
  validateRegion,
  plainSource,
} from "./application-composition-regions";
import { addPlaces, commandSettings, newBlockItem } from "./application-composition-add";
import { studioOwnsSetting } from "./contextual-palette";

/** The page or layout that owns a region. */
export const regionOwner = (region: Region): StudioCompositionOwner | undefined =>
  region.shell !== undefined
    ? { kind: "layout", shellAlias: region.shell.id }
    : region.page !== undefined
      ? { kind: "page", pageAlias: region.page.id }
      : undefined;

export type WrapContainer = Readonly<{
  release: PlatformBlockRelease;
  description: string;
  slotKey: string;
  slotLabel: string;
  unavailable?: string;
  choice: StudioPaletteChoice;
}>;

/**
 * The containers the selected block can be wrapped in: the blocks its current slot admits that
 * have a fixed slot, each with the slot that would hold the block, or why it cannot. A block in a
 * layout or in the ordinary content of a page can be wrapped; the container is judged by the same
 * places the add command offers.
 */
export const resolveWrap = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
) => {
  const catalogue = context.catalogue;
  plainSource(context.source);
  const resolved = resolve(context, selection);
  if (resolved === undefined) return { kind: "invalid" } as const;
  const { source, target, alias } = resolved;
  const region = target.region;
  const owner = regionOwner(region);
  const moved = releaseFor(catalogue, target.item);
  if (
    owner === undefined ||
    moved === undefined ||
    !(region.shell !== undefined || region.ordinaryMain === true || region.parent !== undefined) ||
    !manifestMatches(catalogue, source, region.zone.items) ||
    (region.parent !== undefined && !pinnedRelease(catalogue, source, region.parent))
  )
    return { kind: "unsupported" } as const;
  validateRegion(catalogue, region);
  const places = addPlaces(catalogue, source, owner);
  if (typeof places === "string") return { kind: places } as const;
  const place = places.find(
    (candidate) =>
      candidate.region.shell === region.shell &&
      candidate.region.page === region.page &&
      candidate.region.address?.key === region.address?.key &&
      sameSteps(candidate.steps, target.steps),
  );
  if (place === undefined) return { kind: "unsupported" } as const;
  const containers: WrapContainer[] = [];
  for (const choice of place.target.choices) {
    const release = toolsFor(catalogue).releases.get(`${choice.blockId}:${choice.releaseVersion}`);
    const fixed = release?.slots.filter((slot) => slot.repeats === undefined) ?? [];
    if (release === undefined || fixed.length === 0) continue;
    const accepting = fixed.find((slot) =>
      slot.allowedChildCategories.includes(moved.paletteGroup),
    );
    const taken = [
      ...new Set(
        fixed.flatMap((slot) =>
          slot.allowedChildCategories.map((group) => PALETTE_GROUP_TITLES[group].toLowerCase()),
        ),
      ),
    ];
    // The wrapped block fills the container's required area, so only the reasons that remain count;
    // the container's required settings are asked for before it wraps.
    const unavailable =
      choice.unavailableWhenFilled ??
      (release.key === FORM_CONTAINER_KEY && holdsForm(catalogue, [target.item])
        ? NESTED_FORM_REASON
        : undefined) ??
      (choice.needsQuery
        ? "It reads its own data. Add it from the Blocks panel, then move this block into it."
        : accepting === undefined
          ? `${release.name} takes only ${taken.join(", ")} blocks, not ${PALETTE_GROUP_TITLES[moved.paletteGroup].toLowerCase()} blocks.`
          : undefined);
    const slot = accepting ?? fixed[0]!;
    containers.push({
      release,
      description: choice.description,
      slotKey: slot.key,
      slotLabel: slot.label,
      choice,
      ...(unavailable === undefined ? {} : { unavailable }),
    });
  }
  return { kind: "available", source, target, alias, moved, containers } as const;
};

export const describeStudioCompositionWrap = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
): StudioCompositionWrapModel => {
  try {
    const resolved = resolveWrap(context, selection);
    if (resolved.kind !== "available") return { kind: resolved.kind };
    return {
      kind: "available",
      containers: resolved.containers.map((container) => ({
        blockId: container.release.blockId,
        releaseVersion: container.release.releaseVersion,
        name: container.release.name,
        description: container.description,
        slotLabel: container.slotLabel,
        choice: container.choice,
        ...(container.unavailable === undefined ? {} : { unavailable: container.unavailable }),
      })),
    };
  } catch (error) {
    console.error("[studio] the containers for a block could not be read", error);
    return { kind: "invalid" };
  }
};

/**
 * Puts the selected block into a new container of the chosen release. The container takes the
 * block's place in its slot and in every declared tablet and phone order; the block keeps its
 * name, settings, orders and flow bindings, so an outlet bound to it stays bound.
 */
export const applyWrap = (
  current: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  command: unknown,
): StudioCompositionCommandResult => {
  const input = closedPlain(command, ["kind", "blockId", "releaseVersion", "settings"]);
  if (
    input.kind !== "wrap" ||
    typeof input.blockId !== "string" ||
    typeof input.releaseVersion !== "string"
  )
    return { kind: "invalid" };
  const resolved = resolveWrap(current, selection);
  if (resolved.kind !== "available") return { kind: resolved.kind };
  const { source, target, alias, moved } = resolved;
  const container = resolved.containers.find(
    (candidate) =>
      candidate.release.blockId === input.blockId &&
      candidate.release.releaseVersion === input.releaseVersion,
  );
  if (container === undefined)
    return { kind: "refused", reason: `${moved.name} can't be wrapped in that block here.` };
  if (container.unavailable !== undefined) {
    console.error("[studio] composition wrap refused", {
      part: alias,
      reason: container.unavailable,
    });
    return {
      kind: "refused",
      reason: `${container.release.name} can't wrap ${moved.name}. ${container.unavailable}`,
    };
  }
  const settings = commandSettings(input.settings, container.release.properties);
  if (Object.keys(settings).some(studioOwnsSetting)) return { kind: "invalid" };
  const { alias: wrapperAlias, item: wrapper } = newBlockItem(
    current.catalogue,
    source,
    container.release,
    settings,
    null,
  );
  try {
    const working = workingCopy(target.region);
    const zone = zoneHandle(working, target.steps);
    const inner = zone.items.find((item) => item.props.id === alias);
    if (inner === undefined) return { kind: "invalid" };
    wrapper.props[container.slotKey] = [inner];
    const swap = (ids: readonly string[]) => ids.map((id) => (id === alias ? wrapperAlias : id));
    zone.set(
      zone.items.map((item) => (item === inner ? wrapper : item)),
      zone.order === undefined
        ? undefined
        : {
            ...(zone.order.tablet === undefined ? {} : { tablet: swap(zone.order.tablet) }),
            ...(zone.order.phone === undefined ? {} : { phone: swap(zone.order.phone) }),
          },
    );
    commitWorking(current.catalogue, target.region, working);
    validateStoredApplicationOutlets(current.catalogue, source);
  } catch (error) {
    if (error instanceof StoredCompositionRefusal) {
      console.error("[studio] composition wrap refused", {
        part: error.location,
        reason: error.reason,
      });
      return {
        kind: "refused",
        reason: `${container.release.name} can't wrap ${moved.name}. ${error.message}.`,
      };
    }
    throw error;
  }
  syncStoredBlockDependencies(source);
  return {
    kind: "applied",
    source: applicationSourceDocumentSchema.parse(source),
    placementAlias: wrapperAlias,
  };
};
