import {
  sameCompositionValue as sameValue,
  sourceNames,
  studioPlacementRemovalReference,
  type StudioCompositionRemovalReason,
} from "./composition-references";
export {
  studioPlacementRemovalReference,
  type StudioCompositionRemovalReason,
} from "./composition-references";
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
  sourcePlacementLayoutSchema,
  sourceSlotBreakpointOrders,
  typedSourceSettingValue,
  repeatableSlotItemIdentities,
  repeatableSlotKey,
  isRepeatableSlotIdentity,
  type ComponentSettingFailure,
  type ApplicationRootId,
  type ApplicationSourceDocument,
  type PageSlotAddress,
  type PlatformBlockRelease,
  type BlockPropertySchemaContract,
  type SourceBlockPropertyValueContract,
  type SourceItem,
  type SourcePageZone,
  type SourceSlotOrder,
} from "@vortex/platform/schema";
import {
  boardModeOf,
  boardMoveRecordTypeProblem,
  createStudioBoardQuery,
  ensureStudioBoardTotals,
  studioBoardQueryFits,
} from "./board-source";
import { studioStarterSlots } from "./composition-starters";
import { applyStudioFlowCreate } from "./application-flow-create";
import { createStudioDiscoveryAdapter } from "./discovery-adapter";
import {
  studioPaletteChoices,
  studioQueryOffered,
  studioReleaseReadsQuery,
  type StudioBorrowedChoices,
  type StudioPaletteChoice,
} from "./contextual-palette";
import {
  adjustedSlotOrder,
  freshBlockName,
  StoredCompositionRefusal,
  storedItemRelease,
  syncStoredBlockDependencies,
  validateStoredShell,
  validateStoredZone,
} from "./stored-composition";
import { restoreStudioGridFeatureBindings } from "./grid-features";
import { resolveStudioSelectionInspectorContext } from "./selection-inspector";
import type { StudioSemanticSelection } from "./semantic-selection";

export type StudioCompositionBreakpoint = "desktop" | "tablet" | "phone";
export type StudioCompositionLayout = ReturnType<typeof sourcePlacementLayoutSchema.parse>;
type SourceShell = ApplicationSourceDocument["body"]["shells"][number];
type SourcePage = ApplicationSourceDocument["body"]["pages"][number];
/** One authored slot: its items in desktop order and its authored tablet and phone order. */
type Zone = { items: SourceItem[]; order: SourceSlotOrder | undefined };

/** Local identity only: a command does not grant authority or perform a write. */
export type StudioCompositionContext = Readonly<{
  organizationId: string;
  rootId: ApplicationRootId;
  key: string;
  draftRevision: number;
  localLifetime: number;
  catalogue: ImmutablePlatformBlockCatalogue;
  source: Readonly<ApplicationSourceDocument>;
  /** What the Modules the draft uses offer, from its last compile: the exposed queries a block may read. */
  borrowed: StudioBorrowedChoices | null;
}>;

export type StudioCompositionCommand =
  | Readonly<{
      kind: "order";
      breakpoint: StudioCompositionBreakpoint;
      order: readonly string[] | null;
    }>
  | Readonly<{
      kind: "resize";
      breakpoint: StudioCompositionBreakpoint;
      layout: StudioCompositionLayout | null;
    }>
  | Readonly<{ kind: "move"; destination: StudioCompositionDestination }>
  | Readonly<{ kind: "remove" }>
  /**
   * The one settings edit: the block's complete set settings (a declared setting left out takes
   * its default) and, for a block that reads records, the query it reads.
   */
  | Readonly<{ kind: "settings"; settings: StudioCompositionSettings; query: string | null }>
  | Readonly<{
      kind: "add";
      pageAlias: string;
      area: string;
      destination: StudioCompositionDestination;
      index: number;
      blockId: string;
      releaseVersion: string;
      settings: StudioCompositionSettings;
      query: string | null;
    }>;

/** A block's settings by setting key, each a typed authored value of its declared kind. */
export type StudioCompositionSettings = Readonly<Record<string, SourceBlockPropertyValueContract>>;
/** One place on a page a new block can go: a content area's top, or a fixed slot of a block in it. */
export type StudioCompositionAddTarget = Readonly<{
  /** Stable key of this place among the page's places. */
  id: string;
  /** The page content area (its slot address key). */
  area: string;
  destination: StudioCompositionDestination;
  label: string;
  /** How many blocks deep the place is; the top of a content area is 0. */
  depth: number;
  /** The blocks the catalogue admits here. */
  choices: readonly StudioPaletteChoice[];
}>;
export type StudioCompositionAddTargetsModel =
  | Readonly<{ kind: "available"; targets: readonly StudioCompositionAddTarget[] }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionSettingsModel =
  | Readonly<{
      kind: "available";
      placementAlias: string;
      signedIn: boolean;
      /** Every setting the block's release declares, in declaration order. */
      properties: readonly BlockPropertySchemaContract[];
      settings: StudioCompositionSettings;
      /** Whether the block reads records from a query, which the settings edit chooses. */
      readsQuery: boolean;
      query: string | null;
    }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionDestination =
  Readonly<{ kind: "root" }> | Readonly<{ kind: "child"; parentAlias: string; slotKey: string }>;

export type StudioCompositionDestinationModel =
  | Readonly<{
      kind: "available";
      destinations: readonly Readonly<{
        destination: StudioCompositionDestination;
        label: string;
      }>[];
    }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionCommandResult =
  /** `placementAlias` names the new block of an add. */
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument; placementAlias?: string }>
  /** An add the stored composition refuses; `reason` names the place and the rule. */
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "invalid" | "stale" | "unsupported" }>;

/** What became of one command in the workspace: its kind, and for a refusal why. */
export type StudioCompositionOutcome = Readonly<{
  kind: StudioCompositionCommandResult["kind"];
  reason?: string;
}>;

export type StudioCompositionRemovalModel =
  | Readonly<{ kind: "available"; placementAlias: string; willRemoveUnusedRelease: boolean }>
  | Readonly<{ kind: "blocked"; reason: StudioCompositionRemovalReason }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionEditorModel =
  | Readonly<{
      kind: "available";
      placementAlias: string;
      order: readonly string[];
      explicitOrder: boolean;
      responsiveOrder: boolean;
      layout: StudioCompositionLayout;
      explicitLayout: boolean;
      capabilities: Readonly<
        Pick<PlatformBlockRelease["capabilities"], "gridWidth" | "height" | "responsiveVisibility">
      >;
    }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

type Region = {
  zone: Zone;
  ordinaryMain?: boolean;
  shell?: SourceShell;
  parent?: SourceItem;
  page?: SourcePage;
  address?: PageSlotAddress;
  replace: (zone: SourcePageZone, shell?: SourceShell) => void;
};
type SlotStep = Readonly<{ parentAlias: string; slotKey: string }>;
type Target = {
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
const toolsFor = (catalogue: ImmutablePlatformBlockCatalogue): CompositionCatalogueTools => {
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
const refuse = (): never => {
  throw new TypeError("Composition edit refused");
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) return refuse();
  return value;
};
const breakpointValid = (value: unknown): value is StudioCompositionBreakpoint =>
  value === "desktop" || value === "tablet" || value === "phone";
const effective = <Value>(
  values: { desktop: Value; tablet?: Value | undefined; phone?: Value | undefined },
  breakpoint: StudioCompositionBreakpoint,
): Value =>
  breakpoint === "desktop"
    ? values.desktop
    : breakpoint === "tablet"
      ? (values.tablet ?? values.desktop)
      : (values.phone ?? values.tablet ?? values.desktop);

const validContext = (context: StudioCompositionContext): boolean =>
  applicationRootIdSchema.safeParse(context.rootId).success &&
  organizationIdSchema.safeParse(context.organizationId).success &&
  Number.isSafeInteger(context.draftRevision) &&
  context.draftRevision >= 1 &&
  Number.isSafeInteger(context.localLifetime) &&
  context.localLifetime >= 1 &&
  context.key === context.source.key;

const sameContext = (
  expected: StudioCompositionContext,
  current: StudioCompositionContext,
): boolean =>
  expected.organizationId === current.organizationId &&
  expected.rootId === current.rootId &&
  expected.key === current.key &&
  expected.draftRevision === current.draftRevision &&
  expected.localLifetime === current.localLifetime &&
  expected.catalogue === current.catalogue &&
  expected.source === current.source;

/** Enumerate native regions; a caller cannot supply a JSON pointer or a guessed step id. */
const regions = (source: ApplicationSourceDocument): Region[] => {
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

const releaseFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  item: SourceItem,
): PlatformBlockRelease | undefined => storedItemRelease(catalogue, item);

/**
 * The child slots an item fills, with their authored breakpoint orders. A known release decides
 * which props are slots, including empty ones; otherwise only non-empty item arrays are slots.
 */
const itemSlots = (
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
const itemReading = (catalogue: ImmutablePlatformBlockCatalogue, item: SourceItem) => {
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
const pinnedRelease = (
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
const manifestMatches = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  items: readonly SourceItem[],
): boolean => sourceItemTree(items).every((item) => pinnedRelease(catalogue, source, item));

const resolve = (context: StudioCompositionContext, selection: StudioSemanticSelection | null) => {
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

type MoveDestination = {
  destination: StudioCompositionDestination;
  label: string;
  steps: readonly SlotStep[];
};
const sameSteps = (left: readonly SlotStep[], right: readonly SlotStep[]): boolean =>
  left.length === right.length &&
  left.every(
    (step, index) =>
      step.parentAlias === right[index]?.parentAlias && step.slotKey === right[index]?.slotKey,
  );

/** Only actual non-repeatable slots in this original ordinary region are destinations. */
const moveDestinations = (
  catalogue: ImmutablePlatformBlockCatalogue,
  target: Target,
  alias: string,
): MoveDestination[] => {
  if (target.region.ordinaryMain !== true) return [];
  const subtree = new Set<string>([
    alias,
    ...sourceItemTree([target.item]).map((item) => item.props.id),
  ]);
  const movedRelease = releaseFor(catalogue, target.item) ?? refuse();
  const result: MoveDestination[] = [];
  let selectedPathSupported = target.steps.length === 0;
  const visit = (zone: Zone, steps: readonly SlotStep[]): void => {
    if (sameSteps(steps, target.steps)) selectedPathSupported = true;
    for (const item of zone.items) {
      const parentAlias = item.props.id;
      if (subtree.has(parentAlias)) continue;
      const release = releaseFor(catalogue, item) ?? refuse();
      const slots = itemSlots(catalogue, item);
      for (const declaration of release.slots) {
        if (declaration.repeats !== undefined) continue;
        const child = slots.get(declaration.key);
        if (child === undefined) continue;
        const childSteps = [...steps, { parentAlias, slotKey: declaration.key }];
        if (
          !sameSteps(childSteps, target.steps) &&
          declaration.allowedChildCategories.includes(movedRelease.paletteGroup)
        )
          result.push({
            destination: { kind: "child", parentAlias, slotKey: declaration.key },
            label: `${parentAlias} / ${declaration.label}`,
            steps: childSteps,
          });
        visit(child, childSteps);
      }
    }
  };
  if (target.steps.length > 0)
    result.push({ destination: { kind: "root" }, label: "The main area of this page", steps: [] });
  visit(target.region.zone, []);
  return selectedPathSupported ? result : [];
};

const closedPlain = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
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
const parseDestination = (value: unknown): StudioCompositionDestination => {
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
const sameDestination = (
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

const workingCopy = (region: Region): Working =>
  structuredClone({ items: region.zone.items, order: region.zone.order });

/** The slot a path of steps reaches in a working copy; its order lives on its parent block. */
const zoneHandle = (working: Working, steps: readonly SlotStep[]): ZoneHandle => {
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

const workingItem = (working: Working, steps: readonly SlotStep[], alias: string): SourceItem => {
  const matches = zoneHandle(working, steps).items.filter((item) => item.props.id === alias);
  return matches.length === 1 ? matches[0]! : refuse();
};

/** Judges the edited slot as stored data and writes it into the region's own document. */
const commitWorking = (
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

/** The item with exactly these settings: each declared property it holds is replaced. */
const withSettings = (
  item: SourceItem,
  release: PlatformBlockRelease,
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>,
): void => {
  const declared = new Set(release.properties.map((property) => property.key));
  const { id, ...rest } = item.props;
  item.props = {
    id,
    ...plainSettings(settings),
    ...Object.fromEntries(Object.entries(rest).filter(([key]) => !declared.has(key))),
  } as SourceItem["props"];
};

/** Refuse cycles and accessors before recursive schemas read an authored snapshot. */
const plainSource = (source: unknown): void => {
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

const eligibleAddRelease = (release: PlatformBlockRelease): boolean =>
  release.paletteGroup === "content" &&
  release.slots.length === 0 &&
  release.properties.every((property) => property.kind === "text" && !property.required) &&
  release.capabilities.accessibleName === "optional" &&
  release.supportedStateOperations.length === 0 &&
  release.supportedEvents.every((event) => event === "refresh");

const plainSettings = (settings: Readonly<Record<string, SourceBlockPropertyValueContract>>) =>
  Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, plainSourceSettingValue(value)]),
  );

/** One place on a page where a new block can go, as the palette and the add command know it. */
type AddPlace = { target: StudioCompositionAddTarget; region: Region; steps: readonly SlotStep[] };

/**
 * Every place on one page a new block can go: the top of each content area, and each fixed slot
 * of every block in it, at any depth. Each place lists the newest release of every block the
 * catalogue admits there. A public page, a guided form and a page an experience shows are not
 * offered: their surface rules are not checked here.
 */
const addPlaces = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  pageAlias: string,
): AddPlace[] | "invalid" | "unsupported" => {
  const pages = source.body.pages.filter((page) => page.id === pageAlias);
  const page = pages.length === 1 ? pages[0]! : undefined;
  if (page === undefined) return "invalid";
  if (
    page.type === "public" ||
    page.type === "guided_form" ||
    source.body.public_addresses.some((address) => address.page === page.id) ||
    source.body.experiences?.some((experience) => experience.page === page.key)
  )
    return "unsupported";
  // The page is a resolved nonpublic page; the surface grants no authority.
  const discovery = createStudioDiscoveryAdapter({ catalogue, surface: { kind: "authenticated" } });
  const shellAlias = sourcePageShell(page.composition);
  const shell = source.body.shells.find((candidate) => candidate.id === shellAlias);
  const pageRegions = regions(source).filter(
    (region) => region.page === page && region.address !== undefined,
  );
  const places: AddPlace[] = [];
  for (const region of pageRegions) {
    const address = region.address!;
    let admitted;
    if (region.parent === undefined) admitted = discovery.getPlacementChoices({ kind: "page" });
    else {
      const binding = shell?.content_slots.find((candidate) => candidate.id === address.slot);
      const declared =
        releaseFor(catalogue, region.parent)?.slots.find(
          (slot) => slot.key === binding?.parent_slot,
        )?.allowedChildCategories ?? [];
      admitted = discovery.getPlacementChoices({
        kind: "shell_content",
        allowedChildCategories: (binding?.allowed_child_categories ?? []).filter((group) =>
          declared.includes(group),
        ),
      });
    }
    const area = address.key;
    const areaLabel = pageRegions.length > 1 ? `Page content: ${address.label}` : "Page content";
    places.push({
      region,
      steps: [],
      target: Object.freeze<StudioCompositionAddTarget>({
        id: `${area}|`,
        area,
        destination: { kind: "root" },
        label: areaLabel,
        depth: 0,
        choices: studioPaletteChoices(catalogue, admitted),
      }),
    });
    const visit = (items: readonly SourceItem[], steps: readonly SlotStep[]): void => {
      for (const item of items) {
        const release = releaseFor(catalogue, item);
        if (release === undefined) continue;
        const slots = itemSlots(catalogue, item);
        for (const declaration of release.slots) {
          if (declaration.repeats !== undefined) continue;
          const parentAlias = item.props.id;
          const childSteps = [...steps, { parentAlias, slotKey: declaration.key }];
          places.push({
            region,
            steps: childSteps,
            target: Object.freeze<StudioCompositionAddTarget>({
              id: `${area}|${parentAlias}|${declaration.key}`,
              area,
              destination: { kind: "child", parentAlias, slotKey: declaration.key },
              label: `${release.name} ${parentAlias}: ${declaration.label}`,
              depth: childSteps.length,
              choices: studioPaletteChoices(
                catalogue,
                discovery.getPlacementChoices({
                  kind: "slot",
                  parent: { blockId: release.blockId, releaseVersion: release.releaseVersion },
                  slotKey: declaration.key,
                }),
              ),
            }),
          });
          const child = slots.get(declaration.key);
          if (child !== undefined) visit(child.items, childSteps);
        }
      }
    };
    visit(region.zone.items, []);
  }
  return places;
};

/** The places on one page a new block can go, for the palette and its keyboard add. */
export const describeStudioCompositionAddTargets = (
  context: StudioCompositionContext,
  pageAlias: string,
): StudioCompositionAddTargetsModel => {
  try {
    plainSource(context.source);
    if (!validContext(context)) return { kind: "invalid" };
    const places = addPlaces(
      context.catalogue,
      applicationSourceDocumentSchema.parse(context.source),
      pageAlias,
    );
    return typeof places === "string"
      ? { kind: places }
      : { kind: "available", targets: Object.freeze(places.map((place) => place.target)) };
  } catch (error) {
    console.error("[studio] the places for a new block could not be read", error);
    return { kind: "invalid" };
  }
};

const groupsTaken = (target: StudioCompositionAddTarget): string => {
  const labels = [...new Set(target.choices.map((choice) => choice.groupLabel.toLowerCase()))];
  if (labels.length === 0) return "it takes no new blocks";
  const listed =
    labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;
  return `it takes ${listed} blocks`;
};

/**
 * Adds one new block at one place on a page: a fresh block name, the catalogue's defaults for
 * every setting the person does not give, an empty list for every fixed slot and the default
 * layout. The required settings the catalogue has no default for, and the query of a data block,
 * come with the command. The edited slot is judged as stored data, and a block release the source
 * does not depend on yet becomes a dependency.
 */
const applyAdd = (
  current: StudioCompositionContext,
  command: unknown,
): StudioCompositionCommandResult => {
  const input = closedPlain(command, [
    "kind",
    "pageAlias",
    "area",
    "destination",
    "index",
    "blockId",
    "releaseVersion",
    "settings",
    "query",
  ]);
  if (
    input.kind !== "add" ||
    typeof input.pageAlias !== "string" ||
    typeof input.area !== "string" ||
    typeof input.blockId !== "string" ||
    typeof input.releaseVersion !== "string" ||
    typeof input.index !== "number" ||
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    (input.query !== null && typeof input.query !== "string")
  )
    return { kind: "invalid" };
  plainSource(current.source);
  if (!validContext(current)) return { kind: "invalid" };
  const catalogue = current.catalogue;
  const source = applicationSourceDocumentSchema.parse(current.source);
  const destination = parseDestination(input.destination);
  const places = addPlaces(catalogue, source, input.pageAlias);
  if (typeof places === "string") return { kind: places };
  const place = places.find(
    (candidate) =>
      candidate.target.area === input.area &&
      sameDestination(candidate.target.destination, destination),
  );
  const release = toolsFor(catalogue).releases.get(`${input.blockId}:${input.releaseVersion}`);
  if (place === undefined)
    return { kind: "refused", reason: "This place on the page does not take new blocks." };
  const choice = place.target.choices.find(
    (candidate) =>
      candidate.blockId === input.blockId && candidate.releaseVersion === input.releaseVersion,
  );
  if (release === undefined || choice === undefined)
    return {
      kind: "refused",
      reason: `${release?.name ?? "This block"} can't go into ${place.target.label}: ${groupsTaken(place.target)}.`,
    };
  if (choice.unavailable !== undefined)
    return { kind: "refused", reason: `${choice.name} can't be added yet. ${choice.unavailable}` };

  // The settings the person gave (the setup asks for each required one without a default), each
  // of its declared kind; every other setting takes its catalogue default.
  const settings = commandSettings(input.settings, release.properties);
  const query = input.query;
  if (
    choice.needsQuery !== (query !== null) ||
    (query !== null && !studioQueryOffered(source, current.borrowed, query))
  )
    return { kind: "invalid" };

  const taken = sourceNames(source);
  const alias = freshBlockName(release.key.split(".").at(-1) ?? "block", taken);
  taken.add(alias);
  const item = {
    type: release.rendererKey,
    props: {
      id: alias,
      ...plainSettings(settings),
      ...Object.fromEntries(
        release.slots.filter((slot) => slot.repeats === undefined).map((slot) => [slot.key, []]),
      ),
      ...Object.fromEntries(
        release.slots.flatMap((slot) =>
          repeatableSlotItemIdentities(slot, settings)
            .filter((identity) => isRepeatableSlotIdentity(slot.key, identity))
            .map((identity) => [repeatableSlotKey(slot.key, identity), []]),
        ),
      ),
      ...studioStarterSlots(catalogue, release, taken),
      vortex: {
        block: { block_id: release.blockId, release_version: release.releaseVersion },
        ...(query === null ? {} : { query }),
        responsive: {
          desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
        },
      },
    },
  } as unknown as SourceItem;
  try {
    const working = workingCopy(place.region);
    const last = place.steps.at(-1);
    if (last !== undefined) {
      // A fixed slot the stored block leaves out starts as an empty list.
      const parent = workingItem(working, place.steps.slice(0, -1), last.parentAlias);
      if (!Array.isArray(parent.props[last.slotKey])) parent.props[last.slotKey] = [];
    }
    const zone = zoneHandle(working, place.steps);
    const items = [...zone.items];
    items.splice(Math.min(input.index, items.length), 0, item);
    // Each declared tablet and phone order takes the new block at its desktop position.
    zone.set(
      items,
      adjustedSlotOrder(
        zone.order,
        items.map((entry) => entry.props.id),
      ),
    );
    commitWorking(catalogue, place.region, working);
  } catch (error) {
    if (error instanceof StoredCompositionRefusal)
      return {
        kind: "refused",
        reason: `${choice.name} can't go into ${place.target.label}. ${error.message}.`,
      };
    throw error;
  }
  syncStoredBlockDependencies(source);
  return {
    kind: "applied",
    source: applicationSourceDocumentSchema.parse(source),
    placementAlias: alias,
  };
};

/**
 * The settings a command supplies, each a typed authored value of the declared kind of its key.
 * A value is accepted only when its plain stored form reads back as exactly that value.
 */
const commandSettings = (
  value: unknown,
  properties: readonly BlockPropertySchemaContract[],
): Record<string, SourceBlockPropertyValueContract> => {
  plainSource(value);
  const raw = object(value);
  const result: Record<string, SourceBlockPropertyValueContract> = {};
  for (const key of Object.keys(raw)) {
    const declaration = properties.find((property) => property.key === key) ?? refuse();
    const supplied = raw[key];
    if (!isObject(supplied) || supplied.kind !== declaration.kind) return refuse();
    const failures: ComponentSettingFailure[] = [];
    const typed = typedSourceSettingValue(
      plainSourceSettingValue(supplied as SourceBlockPropertyValueContract),
      declaration,
      [key],
      failures,
    );
    if (typed === undefined || failures.length > 0 || !sameValue(typed, supplied)) return refuse();
    result[key] = typed;
  }
  return result;
};

/**
 * A block's repeatable slots follow its settings: an entry the settings add gets an empty slot,
 * and an entry they remove takes its slot away, which must be empty by then.
 */
const syncRepeatableSlots = (
  item: SourceItem,
  release: PlatformBlockRelease,
  before: Readonly<Record<string, SourceBlockPropertyValueContract>>,
  after: Readonly<Record<string, SourceBlockPropertyValueContract>>,
): string | undefined => {
  for (const declaration of release.slots) {
    if (declaration.repeats === undefined) continue;
    const kept = new Set(
      repeatableSlotItemIdentities(declaration, after)
        .filter((identity) => isRepeatableSlotIdentity(declaration.key, identity))
        .map((identity) => repeatableSlotKey(declaration.key, identity)),
    );
    for (const identity of repeatableSlotItemIdentities(declaration, before)) {
      const key = repeatableSlotKey(declaration.key, identity);
      if (kept.has(key) || item.props[key] === undefined) continue;
      if (Array.isArray(item.props[key]) && (item.props[key] as unknown[]).length > 0)
        return `Its ${declaration.label} for '${identity}' still holds blocks. Move or remove them first`;
      delete item.props[key];
      const orders = item.props.vortex.slot_orders;
      if (orders !== undefined) {
        delete orders[key];
        if (Object.keys(orders).length === 0) delete item.props.vortex.slot_orders;
      }
    }
    for (const key of kept) if (item.props[key] === undefined) item.props[key] = [];
  }
  return undefined;
};

/**
 * Which placed blocks the settings edit reaches: any block on a page that is not public and that
 * no experience shows, in a content area whose blocks all name releases the source depends on.
 * Settings keep a block's identity, so flow references and required content stay intact.
 */
const resolveSettings = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
) => {
  const catalogue = context.catalogue;
  plainSource(context.source);
  const resolved = resolve(context, selection);
  if (resolved === undefined) return { kind: "invalid" } as const;
  const { source, target } = resolved;
  const page = target.region.page;
  if (
    page === undefined ||
    page.type === "public" ||
    source.body.public_addresses.some((address) => address.page === page.id) ||
    source.body.experiences?.some((experience) => experience.page === page.key)
  )
    return { kind: "unsupported" } as const;
  const release = releaseFor(catalogue, target.item);
  if (release === undefined || !manifestMatches(catalogue, source, target.region.zone.items))
    return { kind: "unsupported" } as const;
  validateStoredZone(catalogue, target.region.zone);
  return { kind: "available", ...resolved, release } as const;
};

/** Whether a block reads its records from a query: a data or figures block, or one that has one. */
const readsQuery = (release: PlatformBlockRelease, item: SourceItem): boolean =>
  studioReleaseReadsQuery(release) || item.props.vortex.query !== undefined;

export const describeStudioCompositionSettings = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
): StudioCompositionSettingsModel => {
  try {
    const resolved = resolveSettings(context, selection);
    if (resolved.kind !== "available") return resolved;
    const item = resolved.target.item;
    return {
      kind: "available",
      placementAlias: resolved.alias,
      signedIn: resolved.target.region.page?.type !== "public",
      properties: resolved.release.properties,
      settings: itemReading(context.catalogue, item).settings,
      readsQuery: readsQuery(resolved.release, item),
      query: item.props.vortex.query ?? null,
    };
  } catch {
    return { kind: "invalid" };
  }
};

/** The one settings edit: the block's complete set settings, and the query it reads. */
const applySettings = (
  current: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  command: unknown,
): StudioCompositionCommandResult => {
  const input = closedPlain(command, ["kind", "settings", "query"]);
  if (input.kind !== "settings" || (input.query !== null && typeof input.query !== "string"))
    return { kind: "invalid" };
  const resolved = resolveSettings(current, selection);
  if (resolved.kind !== "available") return resolved;
  const { source, target, alias, release } = resolved;
  const settings = commandSettings(input.settings, release.properties);
  restoreStudioGridFeatureBindings(settings, release.properties, source.body.flow_bindings, alias);
  let query = input.query;
  if (
    query !== null &&
    (!readsQuery(release, target.item) || !studioQueryOffered(source, current.borrowed, query))
  )
    return { kind: "invalid" };
  // A Data grid in Board mode reads an ordinary query grouped by its stage field. Choosing the
  // pipeline binds the grid to the query that groups by it (an existing one, or a new one written
  // like any other query, editable in Data); every other board setting is judged against it.
  const board = boardModeOf(settings);
  const moveProblem =
    board === undefined ? undefined : boardMoveRecordTypeProblem(source, alias, board);
  if (moveProblem !== undefined) return { kind: "refused", reason: moveProblem };
  if (
    board?.columnField !== undefined &&
    board.cardTitleField !== undefined &&
    (query === null || !studioBoardQueryFits(source, board, query))
  ) {
    const made = createStudioBoardQuery(source, board, sourceNames(source), query);
    if ("problem" in made)
      return {
        kind: "refused",
        reason: `${release.name} can't take these settings. ${made.problem}.`,
      };
    query = made.query;
  }
  if (board !== undefined && query !== null) ensureStudioBoardTotals(source, board, query);
  try {
    const working = workingCopy(target.region);
    const item = workingItem(working, target.steps, alias);
    const before = itemReading(current.catalogue, item).settings;
    withSettings(item, release, settings);
    const vortex = { ...item.props.vortex };
    if (query === null) delete vortex.query;
    else vortex.query = query;
    item.props.vortex = vortex;
    const slotProblem = syncRepeatableSlots(item, release, before, settings);
    if (slotProblem !== undefined)
      return {
        kind: "refused",
        reason: `${release.name} can't take these settings. ${slotProblem}.`,
      };
    commitWorking(current.catalogue, target.region, working);
  } catch (error) {
    if (error instanceof StoredCompositionRefusal)
      return {
        kind: "refused",
        reason: `${release.name} can't take these settings. ${error.message}.`,
      };
    throw error;
  }
  // A board's card moves are saved through a flow: the first time the board is on, it gets the
  // one flow that saves the moved card's new stage, so its pipeline and the action owning the
  // stage apply. It stays when the board is switched off and is reused when it is switched on.
  if (
    board?.columnField !== undefined &&
    !source.body.flow_bindings.some(
      (binding) => binding.control === alias && binding.event === "card_moved",
    )
  ) {
    const moved = applyStudioFlowCreate(
      source,
      {
        kind: "action",
        controlAlias: alias,
        name: "Move card",
        recordType: board.columnField.slice(0, board.columnField.lastIndexOf(".")),
        event: "card_moved",
      },
      null,
    );
    if (moved.kind !== "applied") return moved;
    return { kind: "applied", source: moved.source };
  }
  const parsed = applicationSourceDocumentSchema.parse(source);
  return sameValue(parsed, current.source)
    ? { kind: "invalid" }
    : { kind: "applied", source: parsed };
};

type Removal = {
  source: ApplicationSourceDocument;
  target: Target;
  alias: string;
  willRemoveUnusedRelease: boolean;
};
type ResolvedRemoval =
  | { kind: "available"; removal: Removal }
  | Exclude<StudioCompositionRemovalModel, { kind: "available" }>;
const resolveRemoval = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
): ResolvedRemoval => {
  const catalogue = context.catalogue;
  plainSource(context.source);
  const resolved = resolve(context, selection);
  if (resolved === undefined) return { kind: "invalid" };
  const { source, target, alias } = resolved;
  const page = target.region.ordinaryMain === true ? target.region.page : undefined;
  if (
    page === undefined ||
    (page.type !== "list" && page.type !== "detail" && page.type !== "dashboard") ||
    source.body.public_addresses.some((address) => address.page === page.id) ||
    source.body.experiences?.some((experience) => experience.page === page.key)
  )
    return { kind: "unsupported" };
  const release = releaseFor(catalogue, target.item);
  if (
    release === undefined ||
    !eligibleAddRelease(release) ||
    itemSlots(catalogue, target.item).size !== 0 ||
    !manifestMatches(catalogue, source, target.region.zone.items)
  )
    return { kind: "unsupported" };
  validateStoredZone(catalogue, target.region.zone);
  let zone = target.region.zone;
  for (const step of target.steps) {
    const parent = zone.items.find((item) => item.props.id === step.parentAlias);
    const declaration =
      parent === undefined
        ? undefined
        : releaseFor(catalogue, parent)?.slots.find((item) => item.key === step.slotKey);
    const child = parent === undefined ? undefined : itemSlots(catalogue, parent).get(step.slotKey);
    if (declaration === undefined || declaration.repeats !== undefined || child === undefined)
      return { kind: "unsupported" };
    if (child.items === target.zone.items && declaration.required && child.items.length === 1)
      return { kind: "blocked", reason: "required_slot" };
    zone = child;
  }
  const aliases = new Set<string>();
  let releaseUses = 0;
  for (const region of regions(source))
    for (const item of sourceItemTree(region.zone.items)) {
      const id = item.props.id;
      if (aliases.has(id)) return { kind: "invalid" };
      aliases.add(id);
      const block = item.props.vortex.block;
      if (block.block_id === release.blockId && block.release_version === release.releaseVersion)
        releaseUses += 1;
    }
  const reason = studioPlacementRemovalReference(source, alias, aliases);
  return reason === undefined
    ? {
        kind: "available",
        removal: {
          source,
          target,
          alias,
          willRemoveUnusedRelease: releaseUses === 1,
        },
      }
    : { kind: "blocked", reason };
};

export const describeStudioCompositionRemoval = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
): StudioCompositionRemovalModel => {
  try {
    const resolved = resolveRemoval(context, selection);
    return resolved.kind === "available"
      ? {
          kind: "available",
          placementAlias: resolved.removal.alias,
          willRemoveUnusedRelease: resolved.removal.willRemoveUnusedRelease,
        }
      : resolved;
  } catch {
    return { kind: "invalid" };
  }
};

const applyRemoval = (
  current: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  command: unknown,
): StudioCompositionCommandResult => {
  closedPlain(command, ["kind"]);
  const resolved = resolveRemoval(current, selection);
  if (resolved.kind !== "available")
    return { kind: resolved.kind === "invalid" ? "invalid" : "unsupported" };
  const { source, target, alias, willRemoveUnusedRelease } = resolved.removal;
  const working = workingCopy(target.region);
  const zone = zoneHandle(working, target.steps);
  const remaining = zone.items.filter((item) => item.props.id !== alias);
  if (remaining.length !== zone.items.length - 1) return { kind: "invalid" };
  // The block also leaves every declared tablet and phone order of its slot.
  zone.set(
    remaining,
    adjustedSlotOrder(
      zone.order,
      remaining.map((item) => item.props.id),
    ),
  );
  commitWorking(current.catalogue, target.region, working);
  const block = target.item.props.vortex.block;
  if (willRemoveUnusedRelease)
    source.body.platform_block_dependencies = source.body.platform_block_dependencies.filter(
      (dependency) =>
        dependency.block_id !== block.block_id ||
        dependency.release_version !== block.release_version,
    );
  const parsed = applicationSourceDocumentSchema.parse(source);
  return sameValue(parsed, current.source)
    ? { kind: "invalid" }
    : { kind: "applied", source: parsed };
};

export const describeStudioCompositionDestinations = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
): StudioCompositionDestinationModel => {
  try {
    const resolved = resolve(context, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const catalogue = context.catalogue;
    const { target, source, alias } = resolved;
    if (
      target.region.ordinaryMain !== true ||
      !manifestMatches(catalogue, source, target.region.zone.items)
    )
      return { kind: "unsupported" };
    validateStoredZone(catalogue, target.region.zone);
    return {
      kind: "available",
      destinations: moveDestinations(catalogue, target, alias).map(({ destination, label }) => ({
        destination,
        label,
      })),
    };
  } catch {
    return { kind: "invalid" };
  }
};

export const describeStudioCompositionEdit = (
  context: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  breakpoint: StudioCompositionBreakpoint,
): StudioCompositionEditorModel => {
  try {
    if (!breakpointValid(breakpoint)) return { kind: "invalid" };
    const resolved = resolve(context, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const catalogue = context.catalogue;
    const { target, source, alias } = resolved;
    if (
      !manifestMatches(catalogue, source, target.region.zone.items) ||
      (target.region.parent !== undefined &&
        !pinnedRelease(catalogue, source, target.region.parent))
    )
      return { kind: "unsupported" };
    // Validate the complete original region and reserved shell targets before offering controls.
    if (target.region.shell) validateStoredShell(catalogue, target.region.shell);
    else validateStoredZone(catalogue, target.region.zone);
    const release = releaseFor(catalogue, target.item);
    if (release === undefined) return { kind: "unsupported" };
    const responsive = target.item.props.vortex.responsive;
    return {
      kind: "available",
      placementAlias: alias,
      order: [...sourceSlotBreakpointOrders(target.zone.items, target.zone.order)[breakpoint]],
      explicitOrder: breakpoint === "desktop" || target.zone.order?.[breakpoint] !== undefined,
      responsiveOrder: target.responsiveOrder,
      layout: structuredClone(effective(responsive, breakpoint)),
      explicitLayout: responsive[breakpoint] !== undefined,
      capabilities: {
        gridWidth: release.capabilities.gridWidth,
        height: release.capabilities.height,
        responsiveVisibility: release.capabilities.responsiveVisibility,
      },
    };
  } catch {
    return { kind: "invalid" };
  }
};

/** Return one whole native source. The workspace rechecks this context before one history.edit. */
export const applyStudioCompositionCommand = (
  current: StudioCompositionContext,
  expected: StudioCompositionContext,
  selection: StudioSemanticSelection | null,
  command: StudioCompositionCommand,
): StudioCompositionCommandResult => {
  try {
    if (!sameContext(expected, current)) return { kind: "stale" };
    const catalogue = current.catalogue;
    const kind = Object.getOwnPropertyDescriptor(command, "kind");
    if (kind === undefined || kind.get !== undefined || kind.set !== undefined)
      return { kind: "invalid" };
    if (command.kind === "add") return applyAdd(current, command);
    if (command.kind === "remove") return applyRemoval(current, selection, command);
    if (command.kind === "settings") return applySettings(current, selection, command);
    const resolved = resolve(current, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const { source, target, alias } = resolved;
    if (
      !manifestMatches(catalogue, source, target.region.zone.items) ||
      (target.region.parent !== undefined &&
        !pinnedRelease(catalogue, source, target.region.parent))
    )
      return { kind: "unsupported" };
    if (command.kind === "move") {
      closedPlain(command, ["kind", "destination"]);
      if (target.region.ordinaryMain !== true) return { kind: "unsupported" };
      const destination = parseDestination(command.destination);
      const resolvedDestination = moveDestinations(catalogue, target, alias).find((candidate) =>
        sameDestination(candidate.destination, destination),
      );
      if (resolvedDestination === undefined) return { kind: "invalid" };
      const working = workingCopy(target.region);
      const from = zoneHandle(working, target.steps);
      const moved = from.items.find((item) => item.props.id === alias);
      if (moved === undefined || sameSteps(target.steps, resolvedDestination.steps))
        return { kind: "invalid" };
      // The block leaves its slot and every declared order there, then joins the end of the
      // destination slot and of every order declared there.
      const remaining = from.items.filter((item) => item !== moved);
      from.set(
        remaining,
        adjustedSlotOrder(
          from.order,
          remaining.map((item) => item.props.id),
        ),
      );
      const to = zoneHandle(working, resolvedDestination.steps);
      const joined = [...to.items, moved];
      to.set(
        joined,
        adjustedSlotOrder(
          to.order,
          joined.map((item) => item.props.id),
        ),
      );
      commitWorking(catalogue, target.region, working);
      const parsed = applicationSourceDocumentSchema.parse(source);
      return sameValue(parsed, current.source)
        ? { kind: "invalid" }
        : { kind: "applied", source: parsed };
    }
    if (!breakpointValid(command.breakpoint)) return { kind: "invalid" };
    const commandKeys = Reflect.ownKeys(command);
    const allowedKeys =
      command.kind === "order" ? ["kind", "breakpoint", "order"] : ["kind", "breakpoint", "layout"];
    if (
      commandKeys.length !== 3 ||
      commandKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    )
      return { kind: "invalid" };
    const working = workingCopy(target.region);
    if (command.kind === "order") {
      if (command.breakpoint !== "desktop" && !target.responsiveOrder)
        return { kind: "unsupported" };
      const zone = zoneHandle(working, target.steps);
      const desktop = zone.items.map((item) => item.props.id);
      const order: { desktop: string[]; tablet?: string[]; phone?: string[] } = {
        desktop,
        ...(zone.order?.tablet === undefined ? {} : { tablet: [...zone.order.tablet] }),
        ...(zone.order?.phone === undefined ? {} : { phone: [...zone.order.phone] }),
      };
      if (command.order === null) {
        if (command.breakpoint === "desktop") return { kind: "invalid" };
        delete order[command.breakpoint];
      } else {
        if (!Array.isArray(command.order)) return { kind: "invalid" };
        const proposed: unknown[] = [...command.order];
        // The order must name every item of this slot exactly once.
        if (
          proposed.length !== desktop.length ||
          new Set(proposed).size !== proposed.length ||
          proposed.some((id) => typeof id !== "string" || !desktop.includes(id))
        )
          return { kind: "invalid" };
        order[command.breakpoint] = proposed as string[];
      }
      // A release without responsive order applies the same order at every breakpoint; retain
      // explicit declarations while moving their values.
      if (command.breakpoint === "desktop" && !target.responsiveOrder) {
        if (order.tablet !== undefined) order.tablet = [...order.desktop];
        if (order.phone !== undefined) order.phone = [...order.desktop];
      }
      const byId = new Map(zone.items.map((item) => [item.props.id, item]));
      zone.set(
        order.desktop.map((id) => byId.get(id)!),
        order.tablet === undefined && order.phone === undefined
          ? undefined
          : {
              ...(order.tablet === undefined ? {} : { tablet: order.tablet }),
              ...(order.phone === undefined ? {} : { phone: order.phone }),
            },
      );
    } else if (command.kind === "resize") {
      const item = workingItem(working, target.steps, alias);
      // The authored layout is the only layout: the edit replaces exactly this breakpoint.
      const responsive = { ...item.props.vortex.responsive };
      if (command.layout === null) {
        if (command.breakpoint === "desktop") return { kind: "invalid" };
        delete responsive[command.breakpoint];
      } else {
        const checked = sourcePlacementLayoutSchema.safeParse(command.layout);
        if (!checked.success) return { kind: "invalid" };
        responsive[command.breakpoint] = checked.data;
      }
      item.props.vortex = { ...item.props.vortex, responsive };
    } else return { kind: "invalid" };
    commitWorking(catalogue, target.region, working);
    const parsed = applicationSourceDocumentSchema.parse(source);
    if (sameValue(parsed, current.source)) return { kind: "invalid" };
    return { kind: "applied", source: parsed };
  } catch (error) {
    console.error("[studio] composition command could not be applied", error);
    return { kind: "invalid" };
  }
};
