import {
  type ImmutablePlatformBlockCatalogue,
  isRepeatableSlotIdentity,
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
import {
  storedItemRelease,
  validateStoredShell,
  validateStoredZone,
} from "@vortex/platform/schema";
import { isStudioDraftSnapshot } from "./draft-snapshot";
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
const catalogueTools = new WeakMap<ImmutablePlatformBlockCatalogue, CompositionCatalogueTools>();
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

/** A page's editable content is its main area or the content slot its layout opens for it. */
const pageContentRegion = (
  region: Region,
): region is Region & { page: NonNullable<Region["page"]> } =>
  (region.ordinaryMain === true || region.parent !== undefined) &&
  (region.page?.type === "list" ||
    region.page?.type === "detail" ||
    region.page?.type === "form" ||
    region.page?.type === "dashboard");

/** The regions whose blocks move: a page's editable content and a layout's own blocks. */
export const movableRegion = (region: Region): boolean =>
  region.shell !== undefined || pageContentRegion(region);

/**
 * Whether a page is published to people outside the application: a public page, a page at a public
 * address or a page an experience opens. A public address and an experience name their page by its
 * key. The one test for the canvas, the Add, Remove, settings and gate commands.
 */
export const publishedPage = (
  source: ApplicationSourceDocument,
  page: ApplicationSourceDocument["body"]["pages"][number],
): boolean =>
  page.type === "public" ||
  source.body.public_addresses.some((address) => address.page === page.key) ||
  experiencePage(source, page);

/** Whether an experience opens the page (it names its page by key). */
export const experiencePage = (
  source: ApplicationSourceDocument,
  page: ApplicationSourceDocument["body"]["pages"][number],
): boolean => source.body.experiences?.some((experience) => experience.page === page.key) ?? false;

/** Why a page published outside the application takes no new block (a copy, a drop, Add). */
export const PUBLISHED_PAGE_ADD_REASON =
  "This page is published, so blocks can't be added or copied on it here.";

/**
 * Why no block of a region can be removed, or undefined: a page removes only from its editable
 * content, and not from a page published at a public address. A layout's blocks always can leave.
 * The one rule for the canvas (the references behind Puck's permissions) and the composition
 * command the draft agent uses.
 */
export const regionRemovalCause = (
  source: ApplicationSourceDocument,
  region: Region,
): "page_kind" | "public_page" | undefined => {
  if (region.shell !== undefined) return undefined;
  if (!pageContentRegion(region)) return "page_kind";
  const page = region.page;
  return publishedPage(source, page) ? "public_page" : undefined;
};

/**
 * Where a block may not be removed from, or undefined: the region's cause (`regionRemovalCause`),
 * or a repeating slot (a block repeated by a setting). The one rule for the canvas's reasons, the
 * canvas change that carries a removal (`applyPageDataChange`) and the Remove command.
 */
export const removalRule = (
  regionCause: ReturnType<typeof regionRemovalCause>,
  repeating: boolean,
): "page_kind" | "public_page" | "repeating_slot" | undefined =>
  regionCause ?? (repeating ? "repeating_slot" : undefined);

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

/**
 * How many blocks sit above a region's first level: the blocks of its layout that host it. A page
 * shown in a layout is nested inside the layout's container, so the platform's depth limit counts
 * those levels too. A layout's own region and a page without a layout start at none.
 */
export const regionHostLevels = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  region: Region,
): number => {
  if (region.parent === undefined) return 0;
  const hostId = region.parent.props.id;
  const level = (items: readonly SourceItem[], at: number): number | undefined => {
    for (const item of items) {
      if (item.props.id === hostId) return at;
      for (const child of itemSlots(catalogue, item).values()) {
        const found = level(child.items, at + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  for (const shell of source.body.shells) {
    const found = level(shell.layout.content, 1);
    if (found !== undefined) return found;
  }
  return 0;
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
): ReadonlyMap<string, Readonly<Zone>> => {
  // A block of a history snapshot never changes, so its slots are read (and its settings checked)
  // once, however many ways the Inspector and the canvas ask for them.
  if (!isStudioDraftSnapshot(item)) return readItemSlots(catalogue, item);
  let items = readSlots.get(catalogue);
  if (items === undefined) readSlots.set(catalogue, (items = new WeakMap()));
  let slots = items.get(item);
  if (slots === undefined) items.set(item, (slots = readItemSlots(catalogue, item)));
  return slots;
};
const readSlots = new WeakMap<
  ImmutablePlatformBlockCatalogue,
  WeakMap<SourceItem, ReadonlyMap<string, Readonly<Zone>>>
>();

const readItemSlots = (
  catalogue: ImmutablePlatformBlockCatalogue,
  item: SourceItem,
): ReadonlyMap<string, Readonly<Zone>> => {
  const release = releaseFor(catalogue, item);
  const orders = item.props.vortex.slot_orders ?? {};
  const result = new Map<string, Readonly<Zone>>();
  if (release === undefined) {
    for (const [key, items] of sourceItemChildSlots(item))
      result.set(key, Object.freeze({ items, order: orders[key] }));
    return result;
  }
  for (const [key, slot] of readSourceItem(item, release).slots)
    if (slot.items !== undefined)
      result.set(key, Object.freeze({ items: slot.items, order: orders[key] }));
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

/**
 * The block a selection names, in a copy of the draft the caller may edit. A caller that only
 * reads (`reading`) is given the draft's own snapshot instead of a copy made by a full parse, so
 * describing a block costs nothing that grows with the application.
 */
export const resolve = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  reading = false,
) => {
  if (!validContext(context) || selection?.kind !== "placement") return undefined;
  if (!reading || !isStudioDraftSnapshot(context.source))
    return resolveBlock(context, selection, false);
  // The Inspector describes the same block several ways for one snapshot; it is found once.
  const found = readingResolutions.get(context.source) ?? new Map<string, ReadingResolution>();
  readingResolutions.set(context.source, found);
  const key = `${context.rootId}|${selection.placementAlias}`;
  const known = found.get(key);
  if (known !== undefined && known.catalogue === context.catalogue) return known.resolved;
  const resolved = resolveBlock(context, selection, true);
  found.set(key, { catalogue: context.catalogue, resolved });
  return resolved;
};
type ReadingResolution = Readonly<{
  catalogue: ImmutablePlatformBlockCatalogue;
  resolved: ReturnType<typeof resolveBlock>;
}>;
const readingResolutions = new WeakMap<object, Map<string, ReadingResolution>>();

const resolveBlock = (
  context: StudioCompositionContext,
  selection: Extract<StudioSemanticSelection, { kind: "placement" }>,
  reading: boolean,
) => {
  const catalogue = context.catalogue;
  const source = reading
    ? (context.source as ApplicationSourceDocument)
    : applicationSourceDocumentSchema.parse(context.source);
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
  // The content of a history snapshot does not change, so a region that passed is not checked
  // again until an edit makes a new one (the Inspector describes the block several ways per edit).
  const held = region.shell ?? region.zone.items;
  const known = isStudioDraftSnapshot(held);
  const passed = known ? validatedRegions.get(held) : undefined;
  if (passed?.order === region.zone.order && passed?.catalogues.has(catalogue) === true) return;
  if (region.shell === undefined) validateStoredZone(catalogue, region.zone);
  else validateStoredShell(catalogue, region.shell);
  if (known) {
    const catalogues =
      passed !== undefined && passed.order === region.zone.order
        ? passed.catalogues
        : new WeakSet<ImmutablePlatformBlockCatalogue>();
    catalogues.add(catalogue);
    validatedRegions.set(held, { order: region.zone.order, catalogues });
  }
};
const validatedRegions = new WeakMap<
  object,
  { order: unknown; catalogues: WeakSet<ImmutablePlatformBlockCatalogue> }
>();

/** Refuse cycles and accessors before recursive schemas read an authored snapshot. */
export const plainSource = (source: unknown): void => {
  // A history snapshot is plain by construction (copied from data, frozen, without cycles).
  if (isStudioDraftSnapshot(source)) return;
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

/** A block's own settings (not its name, slots or layout), for naming it to a person. */
export const settingsOf = (item: SourceItem): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(item.props).filter(
      ([key, value]) => key !== "id" && key !== "vortex" && !Array.isArray(value),
    ),
  );

/**
 * The declaration of a slot of an item's release by the key the item stores it under: the exact key,
 * or the repeating declaration whose key and an underscore begin it (a tab is stored as
 * `tab_<key>`), as the platform reader splits them.
 */
export const slotDeclaration = <Slot extends { key: string; repeats?: unknown }>(
  release: { slots: readonly Slot[] } | undefined,
  key: string,
): Slot | undefined =>
  release?.slots.find((entry) => entry.repeats === undefined && entry.key === key) ??
  release?.slots.find(
    (entry) =>
      entry.repeats !== undefined &&
      key.startsWith(`${entry.key}_`) &&
      isRepeatableSlotIdentity(entry.key, key.slice(entry.key.length + 1)),
  );
