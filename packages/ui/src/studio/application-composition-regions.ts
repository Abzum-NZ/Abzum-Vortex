import {
  type ImmutablePlatformBlockCatalogue,
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  organizationIdSchema,
  plainSourceSettingValue,
  readSourceItem,
  setSourcePageSlot,
  sourceItemChildSlots,
  sourceItemTree,
  sourcePageShell,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type ApplicationSourceDocument,
  type PageSlotAddress,
  type PlatformBlockRelease,
  type SourceBlockPropertyValueContract,
  type SourceItem,
  type SourcePageZone,
  type SourceSlotOrder,
} from "@vortex/platform/schema";
import { storedItemRelease, validateStoredShell, validateStoredZone } from "./stored-composition";
import { resolveStudioSelectionInspectorContext } from "./selection-inspector";
import type { StudioSemanticSelection } from "./semantic-selection";
import type {
  StudioCompositionContext,
  StudioCompositionOwner,
  StudioCompositionDestination,
} from "./application-composition-model";

type SourceShell = ApplicationSourceDocument["body"]["shells"][number];
type SourcePage = ApplicationSourceDocument["body"]["pages"][number];
/** One authored slot: its items in desktop order and its authored tablet and phone order. */
export type Zone = { items: SourceItem[]; order: SourceSlotOrder | undefined };

export type Region = {
  zone: Zone;
  ordinaryMain?: boolean;
  shell?: SourceShell;
  parent?: SourceItem;
  page?: SourcePage;
  address?: PageSlotAddress;
  replace: (zone: SourcePageZone, shell?: SourceShell) => void;
};
export type SlotStep = Readonly<{ parentAlias: string; slotKey: string }>;
export type Target = {
  region: Region;
  zone: Zone;
  item: SourceItem;
  steps: readonly SlotStep[];
  responsiveOrder: boolean;
};

type CompositionCatalogueTools = Readonly<{
  releases: ReadonlyMap<string, PlatformBlockRelease>;
}>;
const catalogueTools = new WeakMap<
  ImmutablePlatformBlockCatalogue,
  CompositionCatalogueTools
>();
export const toolsFor = (catalogue: ImmutablePlatformBlockCatalogue): CompositionCatalogueTools => {
  let tools = catalogueTools.get(catalogue);
  if (tools === undefined) {
    tools = Object.freeze({
      releases: new Map(
        catalogue.releases.map((release) => [
          `${release.blockId}:${release.releaseVersion}`,
          release,
        ]),
      ),
    });
    catalogueTools.set(catalogue, tools);
  }
  return tools;
};

export const refuse = (): never => {
  throw new TypeError("Composition edit refused");
};
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) return refuse();
  return value;
};

export const validContext = (context: StudioCompositionContext): boolean =>
  applicationRootIdSchema.safeParse(context.rootId).success &&
  organizationIdSchema.safeParse(context.organizationId).success &&
  Number.isSafeInteger(context.draftRevision) &&
  context.draftRevision >= 1 &&
  Number.isSafeInteger(context.localLifetime) &&
  context.localLifetime >= 1 &&
  context.key === context.source.key;

/** Enumerate native regions; a caller cannot supply a JSON pointer or a guessed step id. */
export const regions = (source: ApplicationSourceDocument): Region[] => {
  const result: Region[] = source.body.shells.map((shell) => ({
    zone: {
      items: shell.layout.content,
      order: shell.layout.root.props.vortex.slot_orders.content,
    },
    shell,
    replace: (zone: SourcePageZone, replacement?: SourceShell) => {
      if (replacement !== undefined) {
        shell.layout = replacement.layout;
        return;
      }
      shell.layout.content = zone.items;
      if (zone.order === undefined) delete shell.layout.root.props.vortex.slot_orders.content;
      else shell.layout.root.props.vortex.slot_orders.content = zone.order;
    },
  }));
  const customParent = (shellAlias: string | null, slotAlias: string): SourceItem => {
    const shell = source.body.shells.find((item) => item.id === shellAlias) ?? refuse();
    const binding = shell.content_slots.find((item) => item.id === slotAlias) ?? refuse();
    return (
      sourceItemTree(shell.layout.content).find(
        (item) => item.props.id === binding.parent_placement,
      ) ?? refuse()
    );
  };
  for (const page of source.body.pages) {
    const shellAlias = sourcePageShell(page.composition);
    for (const address of sourcePageSlotAddresses(page)) {
      const zone = sourcePageSlotAt(page, address) ?? refuse();
      result.push({
        zone: { items: zone.items, order: zone.order },
        page,
        address,
        // Guided step content is never an ordinary main region.
        ...(address.slot === undefined
          ? page.type === "guided_form"
            ? {}
            : { ordinaryMain: true }
          : { parent: customParent(shellAlias, address.slot) }),
        replace: (replacement) => {
          if (!setSourcePageSlot(page, address, replacement)) refuse();
        },
      });
    }
  }
  return result;
};

export const releaseFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  item: SourceItem,
): PlatformBlockRelease | undefined => storedItemRelease(catalogue, item);

/**
 * The child slots an item fills, with their authored breakpoint orders. A known release decides
 * which props are slots, including empty ones; otherwise only non-empty item arrays are slots.
 */
export const itemSlots = (
  catalogue: ImmutablePlatformBlockCatalogue,
  item: SourceItem,
): Map<string, Zone> => {
  const release = releaseFor(catalogue, item);
  const orders = item.props.vortex.slot_orders ?? {};
  const result = new Map<string, Zone>();
  if (release === undefined) {
    for (const [key, items] of sourceItemChildSlots(item))
      result.set(key, { items, order: orders[key] });
    return result;
  }
  for (const [key, slot] of readSourceItem(item, release).slots)
    if (slot.items !== undefined) result.set(key, { items: slot.items, order: orders[key] });
  return result;
};

/** The item read against its release; refused when its release is not in the catalogue. */
export const itemReading = (catalogue: ImmutablePlatformBlockCatalogue, item: SourceItem) => {
  const release = releaseFor(catalogue, item) ?? refuse();
  return readSourceItem(item, release);
};

const targetFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  alias: string,
): Target | undefined => {
  const matches: Target[] = [];
  for (const region of regions(source)) {
    let count = 0;
    const visit = (zone: Zone, steps: readonly SlotStep[], responsiveOrder: boolean): void => {
      if (steps.length >= catalogue.compositionPolicy.maximumDepth && zone.items.length > 0)
        return refuse();
      for (const item of zone.items) {
        const id = item.props.id;
        if (++count > catalogue.compositionPolicy.maximumPlacements) return refuse();
        if (id === alias) matches.push({ region, zone, item, steps, responsiveOrder });
        for (const [slotKey, child] of itemSlots(catalogue, item))
          visit(
            child,
            [...steps, { parentAlias: id, slotKey }],
            releaseFor(catalogue, item)?.capabilities.responsiveOrder === true,
          );
      }
    };
    visit(
      region.zone,
      [],
      region.parent === undefined ||
        releaseFor(catalogue, region.parent)?.capabilities.responsiveOrder === true,
    );
  }
  return matches.length === 1 ? matches[0] : undefined;
};

/** Only the selected region needs supported releases; unrelated regions remain untouched. */
export const pinnedRelease = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  item: SourceItem,
): boolean => {
  const release = releaseFor(catalogue, item);
  return (
    release !== undefined &&
    source.body.platform_block_dependencies.some(
      (dependency) =>
        dependency.block_id === release.blockId &&
        dependency.release_version === release.releaseVersion,
    )
  );
};
export const manifestMatches = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  items: readonly SourceItem[],
): boolean => sourceItemTree(items).every((item) => pinnedRelease(catalogue, source, item));

export const resolve = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
) => {
  if (!validContext(context) || selection?.kind !== "placement") return undefined;
  const catalogue = context.catalogue;
  const source = applicationSourceDocumentSchema.parse(context.source);
  if (
    resolveStudioSelectionInspectorContext({ rootId: context.rootId, source }, selection).status !==
    "resolved"
  )
    return undefined;
  const target = targetFor(catalogue, source, selection.placementAlias);
  return target === undefined ? undefined : { source, target, alias: selection.placementAlias };
};

export const sameSteps = (left: readonly SlotStep[], right: readonly SlotStep[]): boolean =>
  left.length === right.length &&
  left.every(
    (step, index) =>
      step.parentAlias === right[index]?.parentAlias && step.slotKey === right[index]?.slotKey,
  );

export const closedPlain = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const record = object(value);
  const prototype = Object.getPrototypeOf(record);
  const own = Reflect.ownKeys(record);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(record)).some(
      (property) => property.get !== undefined || property.set !== undefined,
    )
  )
    return refuse();
  return record;
};
export const parseDestination = (value: unknown): StudioCompositionDestination => {
  const candidate = object(value);
  // Read the discriminant only after rejecting accessors and non-plain objects.
  const descriptor = Object.getOwnPropertyDescriptor(candidate, "kind");
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined)
    return refuse();
  if (descriptor.value === "root") {
    closedPlain(candidate, ["kind"]);
    return { kind: "root" };
  }
  const child = closedPlain(candidate, ["kind", "parentAlias", "slotKey"]);
  if (
    child.kind !== "child" ||
    typeof child.parentAlias !== "string" ||
    child.parentAlias.length === 0 ||
    typeof child.slotKey !== "string" ||
    child.slotKey.length === 0
  )
    return refuse();
  return { kind: "child", parentAlias: child.parentAlias, slotKey: child.slotKey };
};
export const parseOwner = (value: unknown): StudioCompositionOwner => {
  const candidate = object(value);
  if (candidate.kind === "page") {
    const page = closedPlain(candidate, ["kind", "pageAlias"]);
    if (typeof page.pageAlias !== "string") return refuse();
    return { kind: "page", pageAlias: page.pageAlias };
  }
  const layout = closedPlain(candidate, ["kind", "shellAlias"]);
  if (layout.kind !== "layout" || typeof layout.shellAlias !== "string") return refuse();
  return { kind: "layout", shellAlias: layout.shellAlias };
};
export const sameDestination = (
  left: StudioCompositionDestination,
  right: StudioCompositionDestination,
): boolean =>
  left.kind === "root"
    ? right.kind === "root"
    : right.kind === "child" &&
      left.parentAlias === right.parentAlias &&
      left.slotKey === right.slotKey;

/** A working copy of one region's stored slot; commands edit it and commit it as a whole. */
type Working = { items: SourceItem[]; order: SourceSlotOrder | undefined };
/** One slot of a working copy: its items, its declared order and how to write both back. */
type ZoneHandle = Readonly<{
  items: SourceItem[];
  order: SourceSlotOrder | undefined;
  set: (items: SourceItem[], order: SourceSlotOrder | undefined) => void;
}>;

export const workingCopy = (region: Region): Working =>
  structuredClone({ items: region.zone.items, order: region.zone.order });

/** The slot a path of steps reaches in a working copy; its order lives on its parent block. */
export const zoneHandle = (working: Working, steps: readonly SlotStep[]): ZoneHandle => {
  if (steps.length === 0)
    return {
      items: working.items,
      order: working.order,
      set: (items, order) => {
        working.items = items;
        working.order = order;
      },
    };
  let items = working.items;
  let parent: SourceItem | undefined;
  for (const step of steps) {
    const matches = items.filter((item) => item.props.id === step.parentAlias);
    if (matches.length !== 1) return refuse();
    parent = matches[0]!;
    const child = parent.props[step.slotKey];
    if (!Array.isArray(child)) return refuse();
    items = child as SourceItem[];
  }
  const holder = parent!;
  const key = steps.at(-1)!.slotKey;
  return {
    items,
    order: holder.props.vortex.slot_orders?.[key],
    set: (next, order) => {
      holder.props[key] = next;
      const orders = { ...holder.props.vortex.slot_orders };
      if (order === undefined) delete orders[key];
      else orders[key] = order;
      if (Object.keys(orders).length === 0) delete holder.props.vortex.slot_orders;
      else holder.props.vortex.slot_orders = orders;
    },
  };
};

/** The region's content once the block leaves its slot and, for a move, joins the end of another. */
export const regionAfter = (
  target: Target,
  alias: string,
  destination?: readonly SlotStep[],
): SourceItem[] => {
  const working = workingCopy(target.region);
  const from = zoneHandle(working, target.steps);
  const moved = from.items.find((item) => item.props.id === alias) ?? refuse();
  from.set(
    from.items.filter((item) => item !== moved),
    from.order,
  );
  if (destination !== undefined) {
    const to = zoneHandle(working, destination);
    to.set([...to.items, moved], to.order);
  }
  return working.items;
};

export const workingItem = (
  working: Working,
  steps: readonly SlotStep[],
  alias: string,
): SourceItem => {
  const matches = zoneHandle(working, steps).items.filter((item) => item.props.id === alias);
  return matches.length === 1 ? matches[0]! : refuse();
};

/** Judges the edited slot as stored data and writes it into the region's own document. */
export const commitWorking = (
  catalogue: ImmutablePlatformBlockCatalogue,
  region: Region,
  working: Working,
): void => {
  if (region.shell === undefined) {
    region.replace(validateStoredZone(catalogue, working));
    return;
  }
  const shell = validateStoredShell(catalogue, {
    ...region.shell,
    layout: {
      root: {
        props: {
          vortex: { slot_orders: working.order === undefined ? {} : { content: working.order } },
        },
      },
      content: working.items,
    },
  });
  region.replace(
    { items: shell.layout.content, order: shell.layout.root.props.vortex.slot_orders.content },
    shell,
  );
};

/** Judges a region as stored data: a layout as a whole, any other region as its slot. */
export const validateRegion = (
  catalogue: ImmutablePlatformBlockCatalogue,
  region: Region,
): void => {
  if (region.shell === undefined) validateStoredZone(catalogue, region.zone);
  else validateStoredShell(catalogue, region.shell);
};

/** Refuse cycles and accessors before recursive schemas read an authored snapshot. */
export const plainSource = (source: unknown): void => {
  const pending = [{ value: source, exit: false }];
  const ancestors = new Set<object>();
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const value = entry.value;
    if (value === null || typeof value !== "object") {
      if (
        value !== undefined &&
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      )
        return refuse();
      continue;
    }
    if (entry.exit) {
      ancestors.delete(value);
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      (Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null) ||
      ancestors.has(value)
    )
      return refuse();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.values(descriptors).some(
        (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
      )
    )
      return refuse();
    ancestors.add(value);
    pending.push({ value, exit: true });
    for (const descriptor of Object.values(descriptors))
      pending.push({ value: descriptor.value, exit: false });
  }
};

export const plainSettings = (
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>,
) =>
  Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, plainSourceSettingValue(value)]),
  );
