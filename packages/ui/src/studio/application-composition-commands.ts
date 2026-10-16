import {
  type ImmutablePlatformBlockCatalogue,
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  organizationIdSchema,
  flowTaskRegistry,
  flowMaximumTaskCount,
  flowMaximumTaskNestingDepth,
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
  validateComponentSettings,
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
import { createStudioDiscoveryAdapter } from "./discovery-adapter";
import { getStudioContextualPaletteGroups } from "./contextual-palette";
import { createVortexAuthoredPuckAdapter } from "./vortex-authored-puck-adapter";
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
}>;

export type StudioCompositionCommand =
  | Readonly<{ kind: "order"; breakpoint: StudioCompositionBreakpoint; order: readonly string[] | null }>
  | Readonly<{ kind: "resize"; breakpoint: StudioCompositionBreakpoint; layout: StudioCompositionLayout | null }>
  | Readonly<{ kind: "move"; destination: StudioCompositionDestination }>
  | Readonly<{ kind: "remove" }>
  | Readonly<{ kind: "settings"; settings: StudioCompositionTextSettings }>
  | Readonly<{ kind: "scalar_settings"; settings: StudioCompositionScalarSettings }>
  | Readonly<{ kind: "add"; blockId: string; releaseVersion: string; alias: string;
      settings: StudioCompositionAddSettings }>;

export type StudioCompositionTextSettings = Readonly<Record<string, Readonly<{ kind: "text"; value: string }>>>;
export type StudioCompositionAddSettings = Readonly<Record<string,
  Readonly<{ kind: "text"; value: string }> | Readonly<{ kind: "boolean"; value: boolean }> |
  Readonly<{ kind: "choice"; value: string }>>>;
export type StudioCompositionScalarSettings = Readonly<Record<string,
  Readonly<{ kind: "boolean"; value: boolean }> | Readonly<{ kind: "choice"; value: string }> |
  Readonly<{ kind: "number"; value: number }>>>;
type ScalarProperty = Extract<BlockPropertySchemaContract, { kind: "boolean" | "choice" | "number" }>;
export type StudioCompositionScalarSettingsModel =
  | Readonly<{ kind: "available"; placementAlias: string; properties: readonly ScalarProperty[];
      settings: StudioCompositionScalarSettings }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;
export type StudioCompositionPaletteChoice = Readonly<{
  id: string; blockId: string; releaseVersion: string; key: string; name: string;
  properties: readonly Extract<BlockPropertySchemaContract, { kind: "text" | "boolean" | "choice" }>[];
  slots: readonly Readonly<{ key: string; label: string }>[];
}>;
export type StudioCompositionPaletteModel =
  | Readonly<{ kind: "available"; choices: readonly StudioCompositionPaletteChoice[] }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionSettingsModel =
  | Readonly<{ kind: "available"; placementAlias: string;
      properties: readonly Extract<BlockPropertySchemaContract, { kind: "text" }>[];
      settings: StudioCompositionTextSettings }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionDestination =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "child"; parentAlias: string; slotKey: string }>;

export type StudioCompositionDestinationModel =
  | Readonly<{ kind: "available"; destinations: readonly Readonly<{
      destination: StudioCompositionDestination; label: string;
    }>[] }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

export type StudioCompositionCommandResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "invalid" | "stale" | "unsupported" }>;

export type StudioCompositionRemovalReason =
  "flow_control" | "flow_form" | "flow_component" | "flow_panel" | "required_slot" | "unresolved_target";
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
      capabilities: Readonly<Pick<PlatformBlockRelease["capabilities"],
        "gridWidth" | "height" | "responsiveVisibility">>;
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
type Target = { region: Region; zone: Zone; item: SourceItem;
  steps: readonly SlotStep[]; responsiveOrder: boolean };

type CompositionCatalogueTools = Readonly<{
  bridge: ReturnType<typeof createVortexAuthoredPuckAdapter>;
  releases: ReadonlyMap<string, PlatformBlockRelease>;
}>;
const catalogueTools = new WeakMap<ImmutablePlatformBlockCatalogue, CompositionCatalogueTools>();
const toolsFor = (catalogue: ImmutablePlatformBlockCatalogue): CompositionCatalogueTools => {
  let tools = catalogueTools.get(catalogue);
  if (tools === undefined) {
    tools = Object.freeze({
      bridge: createVortexAuthoredPuckAdapter(catalogue),
      releases: new Map(catalogue.releases.map((release) =>
        [`${release.blockId}:${release.releaseVersion}`, release])),
    });
    catalogueTools.set(catalogue, tools);
  }
  return tools;
};
const refuse = (): never => { throw new TypeError("Composition edit refused"); };
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) return refuse();
  return value;
};
const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value: unknown, index: number) => sameValue(value, right[index]));
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
};
const breakpointValid = (value: unknown): value is StudioCompositionBreakpoint =>
  value === "desktop" || value === "tablet" || value === "phone";
const effective = <Value>(values: { desktop: Value; tablet?: Value | undefined; phone?: Value | undefined },
  breakpoint: StudioCompositionBreakpoint): Value => breakpoint === "desktop" ? values.desktop
  : breakpoint === "tablet" ? values.tablet ?? values.desktop : values.phone ?? values.tablet ?? values.desktop;

const validContext = (context: StudioCompositionContext): boolean =>
  applicationRootIdSchema.safeParse(context.rootId).success &&
  organizationIdSchema.safeParse(context.organizationId).success &&
  Number.isSafeInteger(context.draftRevision) && context.draftRevision >= 1 &&
  Number.isSafeInteger(context.localLifetime) && context.localLifetime >= 1 &&
  context.key === context.source.key;

const sameContext = (expected: StudioCompositionContext, current: StudioCompositionContext): boolean =>
  expected.organizationId === current.organizationId && expected.rootId === current.rootId &&
  expected.key === current.key && expected.draftRevision === current.draftRevision &&
  expected.localLifetime === current.localLifetime && expected.catalogue === current.catalogue &&
  expected.source === current.source;

/** Enumerate native regions; a caller cannot supply a JSON pointer or a guessed step id. */
const regions = (source: ApplicationSourceDocument): Region[] => {
  const result: Region[] = source.body.shells.map((shell) => ({
    zone: { items: shell.layout.content, order: shell.layout.root.props.vortex.slot_orders.content },
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
    return sourceItemTree(shell.layout.content).find((item) =>
      item.props.id === binding.parent_placement) ?? refuse();
  };
  for (const page of source.body.pages) {
    const shellAlias = sourcePageShell(page.composition);
    for (const address of sourcePageSlotAddresses(page)) {
      const zone = sourcePageSlotAt(page, address) ?? refuse();
      result.push({
        zone: { items: zone.items, order: zone.order }, page, address,
        // Guided step content is never an ordinary main region.
        ...(address.slot === undefined
          ? page.type === "guided_form" ? {} : { ordinaryMain: true }
          : { parent: customParent(shellAlias, address.slot) }),
        replace: (replacement) => { if (!setSourcePageSlot(page, address, replacement)) refuse(); },
      });
    }
  }
  return result;
};

const releaseFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  item: SourceItem,
): PlatformBlockRelease | undefined =>
  toolsFor(catalogue).releases.get(
    `${item.props.vortex.block.block_id}:${item.props.vortex.block.release_version}`);

/**
 * The child slots an item fills, with their authored breakpoint orders. A known release decides
 * which props are slots, including empty ones; otherwise only non-empty item arrays are slots.
 */
const itemSlots = (catalogue: ImmutablePlatformBlockCatalogue, item: SourceItem): Map<string, Zone> => {
  const release = releaseFor(catalogue, item);
  const orders = item.props.vortex.slot_orders ?? {};
  const result = new Map<string, Zone>();
  if (release === undefined) {
    for (const [key, items] of sourceItemChildSlots(item)) result.set(key, { items, order: orders[key] });
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
          visit(child, [...steps, { parentAlias: id, slotKey }],
            releaseFor(catalogue, item)?.capabilities.responsiveOrder === true);
      }
    };
    visit(region.zone, [], region.parent === undefined ||
      releaseFor(catalogue, region.parent)?.capabilities.responsiveOrder === true);
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
  return release !== undefined && source.body.platform_block_dependencies.some((dependency) =>
    dependency.block_id === release.blockId && dependency.release_version === release.releaseVersion);
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
  if (resolveStudioSelectionInspectorContext({ rootId: context.rootId, source }, selection).status !== "resolved")
    return undefined;
  const target = targetFor(catalogue, source, selection.placementAlias);
  return target === undefined ? undefined : { source, target, alias: selection.placementAlias };
};

type MoveDestination = {
  destination: StudioCompositionDestination; label: string; steps: readonly SlotStep[];
};
const sameSteps = (left: readonly SlotStep[], right: readonly SlotStep[]): boolean =>
  left.length === right.length && left.every((step, index) =>
    step.parentAlias === right[index]?.parentAlias && step.slotKey === right[index]?.slotKey);

/** Only actual non-repeatable slots in this original ordinary region are destinations. */
const moveDestinations = (
  catalogue: ImmutablePlatformBlockCatalogue,
  target: Target,
  alias: string,
): MoveDestination[] => {
  if (target.region.ordinaryMain !== true) return [];
  const subtree = new Set<string>([alias,
    ...sourceItemTree([target.item]).map((item) => item.props.id)]);
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
        if (!sameSteps(childSteps, target.steps) &&
          declaration.allowedChildCategories.includes(movedRelease.paletteGroup))
          result.push({ destination: { kind: "child", parentAlias, slotKey: declaration.key },
            label: `${parentAlias} / ${declaration.label}`, steps: childSteps });
        visit(child, childSteps);
      }
    }
  };
  if (target.steps.length > 0) result.push({ destination: { kind: "root" },
    label: "The main area of this page", steps: [] });
  visit(target.region.zone, []);
  return selectedPathSupported ? result : [];
};

const closedPlain = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const record = object(value);
  const prototype = Object.getPrototypeOf(record);
  const own = Reflect.ownKeys(record);
  if ((prototype !== Object.prototype && prototype !== null) || own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(record)).some((property) =>
      property.get !== undefined || property.set !== undefined)) return refuse();
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
  if (child.kind !== "child" || typeof child.parentAlias !== "string" || child.parentAlias.length === 0 ||
    typeof child.slotKey !== "string" || child.slotKey.length === 0) return refuse();
  return { kind: "child", parentAlias: child.parentAlias, slotKey: child.slotKey };
};
const sameDestination = (left: StudioCompositionDestination, right: StudioCompositionDestination): boolean =>
  left.kind === "root" ? right.kind === "root" : right.kind === "child" &&
    left.parentAlias === right.parentAlias && left.slotKey === right.slotKey;

const privateContentAt = (root: unknown, steps: readonly SlotStep[]): unknown[] => {
  let content = root;
  for (const step of steps) {
    if (!Array.isArray(content)) return refuse();
    const matches = content.filter((value: unknown) => object(object(value).props).id === step.parentAlias);
    if (matches.length !== 1) return refuse();
    content = object(object(matches[0]).props)[step.slotKey];
  }
  if (!Array.isArray(content)) return refuse();
  return content;
};

/** Refuse cycles and accessors before recursive schemas read an authored snapshot. */
const plainSource = (source: unknown): void => {
  const pending = [{ value: source, exit: false }];
  const ancestors = new Set<object>();
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const value = entry.value;
    if (value === null || typeof value !== "object") {
      if (value !== undefined && typeof value !== "string" && typeof value !== "number" &&
        typeof value !== "boolean") return refuse();
      continue;
    }
    if (entry.exit) { ancestors.delete(value); continue; }
    const prototype = Object.getPrototypeOf(value);
    if ((Array.isArray(value) ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) return refuse();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined))
      return refuse();
    ancestors.add(value);
    pending.push({ value, exit: true });
    for (const descriptor of Object.values(descriptors)) pending.push({ value: descriptor.value, exit: false });
  }
};

const eligibleAddRelease = (release: PlatformBlockRelease): boolean =>
  release.paletteGroup === "content" && release.slots.length === 0 &&
  release.properties.every((property) => property.kind === "text" && !property.required) &&
  release.capabilities.accessibleName === "optional" && release.supportedStateOperations.length === 0 &&
  release.supportedEvents.every((event) => event === "refresh");

/** Empty fixed slots need no child identity, reference resolution or required seed content. */
const eligibleLayoutAddRelease = (release: PlatformBlockRelease): boolean =>
  release.paletteGroup === "layout" && release.slots.length > 0 &&
  release.slots.every((slot) => !slot.required && slot.repeats === undefined) &&
  release.properties.every((property) => !property.required &&
    (property.kind === "boolean" || property.kind === "choice")) &&
  release.capabilities.accessibleName === "not_applicable" &&
  release.supportedEvents.length === 0 && release.supportedStateOperations.length === 0;

/** Existing fixed-slot layouts retain their children when editing declared scalar settings. */
const eligibleLayoutSettingsRelease = (release: PlatformBlockRelease): boolean =>
  release.paletteGroup === "layout" && release.slots.length > 0 &&
  release.slots.every((slot) => !slot.required && slot.repeats === undefined) &&
  release.properties.every((property) => !property.required &&
    (property.kind === "boolean" || property.kind === "choice" || property.kind === "number")) &&
  release.capabilities.accessibleName === "not_applicable" &&
  release.supportedEvents.length === 0 && release.supportedStateOperations.length === 0;

type AddTarget =
  | { kind: "available"; source: ApplicationSourceDocument; main: Zone;
      layoutAllowed: boolean; replace: (zone: SourcePageZone) => void }
  | { kind: "invalid" | "unsupported" };
const resolveAdd = (context: StudioCompositionContext, selection: StudioSemanticSelection | null): AddTarget => {
  if (selection?.kind !== "page") return { kind: "invalid" };
  plainSource(context.source);
  if (!validContext(context)) return { kind: "invalid" };
  const catalogue = context.catalogue;
  const { bridge } = toolsFor(catalogue);
  // Bound and validate the actual selected raw region before the recursive whole-source schema.
  const rawPages = object(object(context.source).body).pages;
  if (!Array.isArray(rawPages)) return { kind: "invalid" };
  const rawMatches = rawPages.filter((page: unknown) => object(page).id === selection.pageAlias);
  if (rawMatches.length !== 1) return { kind: "invalid" };
  const rawPage = object(rawMatches[0]);
  const rawComposition = object(rawPage.composition);
  if (rawPage.type === "public" || rawPage.type === "guided_form") return { kind: "unsupported" };
  const rawFrame = object(object(object(rawComposition.root).props).vortex);
  if (rawFrame.shell !== null) return { kind: "unsupported" };
  bridge.toPuckData({ items: rawComposition.content,
    order: rawFrame.slot_orders === undefined ? undefined : object(rawFrame.slot_orders).content });
  const source = applicationSourceDocumentSchema.parse(context.source);
  if (resolveStudioSelectionInspectorContext({ rootId: context.rootId, source }, selection).status !== "resolved")
    return { kind: "invalid" };
  const pages = source.body.pages.filter((page) => page.id === selection.pageAlias);
  const page = pages.length === 1 ? pages[0] : undefined;
  if (page === undefined) return { kind: "invalid" };
  if (page.type === "public" || page.type === "guided_form" || sourcePageShell(page.composition) !== null)
    return { kind: "unsupported" };
  const address = sourcePageSlotAddresses(page)[0] ?? refuse();
  const main = sourcePageSlotAt(page, address) ?? refuse();
  if (!manifestMatches(catalogue, source, main.items)) return { kind: "unsupported" };
  return { kind: "available", source, main: { items: main.items, order: main.order },
    layoutAllowed: (page.type === "list" || page.type === "detail" || page.type === "dashboard") &&
      !source.body.public_addresses.some((address) => address.page === page.id) &&
      !source.body.experiences?.some((experience) => experience.page === page.key),
    replace: (zone) => { if (!setSourcePageSlot(page, address, zone)) refuse(); } };
};

const addChoices = (
  catalogue: ImmutablePlatformBlockCatalogue,
  searchText: string,
  authoredAlias: string,
  layoutAllowed: boolean,
): StudioCompositionPaletteChoice[] => {
  // This surface describes an already resolved nonpublic page; it grants no authority.
  const discovery = createStudioDiscoveryAdapter({ catalogue, surface: { kind: "authenticated" } });
  const { bridge, releases } = toolsFor(catalogue);
  return getStudioContextualPaletteGroups(discovery, { kind: "page" }, searchText)
    .flatMap((group) => group.choices).flatMap((choice) => {
      const release = releases.get(`${choice.blockId}:${choice.releaseVersion}`);
      if (release === undefined || (!eligibleAddRelease(release) &&
        !(layoutAllowed && eligibleLayoutAddRelease(release)))) return [];
      const properties = release.properties.map((property) => {
        if (property.kind !== "text" && property.kind !== "boolean" && property.kind !== "choice") return refuse();
        return property;
      });
      // Optional declarations must really accept omission and the native seed.
      // Validation uses an existing authored alias or the user's proposed alias,
      // never a generated placement identity. This detached seed is not persisted.
      bridge.toPuckData(seedZone(release, authoredAlias, {}));
      return [{ id: choice.id, blockId: release.blockId, releaseVersion: release.releaseVersion,
        key: release.key, name: release.name, properties,
        slots: release.slots.map((slot) => ({ key: slot.key, label: slot.label })) }];
    });
};

const plainSettings = (settings: Readonly<Record<string, SourceBlockPropertyValueContract>>) =>
  Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, plainSourceSettingValue(value)]));

/** One new item: its plain settings, an empty array for every slot and default responsive layout. */
const seedZone = (release: PlatformBlockRelease, alias: string,
  settings: StudioCompositionAddSettings): Zone => ({
  items: [{ type: release.rendererKey, props: {
    id: alias,
    ...plainSettings(structuredClone(settings)),
    ...Object.fromEntries(release.slots.map((slot) => [slot.key, []])),
    vortex: {
      block: { block_id: release.blockId, release_version: release.releaseVersion },
      theme_overrides: {},
      responsive: { desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } } },
    },
  } }],
  order: undefined,
});

export const describeStudioCompositionPalette = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null, searchText = ""): StudioCompositionPaletteModel => {
  try {
    if (selection?.kind !== "page") return { kind: "invalid" };
    const target = resolveAdd(context, selection);
    return target.kind === "available"
      ? { kind: "available", choices: addChoices(context.catalogue, searchText, selection.pageAlias, target.layoutAllowed) } : target;
  } catch { return { kind: "invalid" }; }
};

const applyAdd = (current: StudioCompositionContext, selection: StudioSemanticSelection | null,
  command: unknown): StudioCompositionCommandResult => {
  const catalogue = current.catalogue;
  const { bridge, releases } = toolsFor(catalogue);
  const input = closedPlain(command, ["kind", "blockId", "releaseVersion", "alias", "settings"]);
  if (input.kind !== "add" || typeof input.blockId !== "string" || typeof input.releaseVersion !== "string")
    return { kind: "invalid" };
  // The public source document exposes the same portable source-alias schema.
  const alias = applicationSourceDocumentSchema.shape.root_alias.parse(input.alias);
  const target = resolveAdd(current, selection);
  if (target.kind !== "available") return target;
  const release = releases.get(`${input.blockId}:${input.releaseVersion}`);
  if (release === undefined || (!eligibleAddRelease(release) &&
    !(target.layoutAllowed && eligibleLayoutAddRelease(release))) ||
    !addChoices(catalogue, "", alias, target.layoutAllowed).some((choice) =>
      choice.blockId === input.blockId && choice.releaseVersion === input.releaseVersion))
    return { kind: "unsupported" };
  if (regions(target.source).some((region) =>
    sourceItemTree(region.zone.items).some((item) => item.props.id === alias)))
    return { kind: "invalid" };
  const rawSettings = object(input.settings);
  const settingKeys = Reflect.ownKeys(rawSettings);
  if (settingKeys.some((key) => typeof key !== "string" || !release.properties.some((property) => property.key === key)))
    return { kind: "invalid" };
  closedPlain(rawSettings, release.properties.filter((property) => Object.hasOwn(rawSettings, property.key))
    .map((property) => property.key));
  const settings: Record<string, { kind: "text"; value: string } | { kind: "boolean"; value: boolean } |
    { kind: "choice"; value: string }> = {};
  for (const key of Object.getOwnPropertyNames(rawSettings)) {
    const property = release.properties.find((declaration) => declaration.key === key);
    const value = closedPlain(rawSettings[key], ["kind", "value"]);
    if (property?.kind === "text" && value.kind === "text" && typeof value.value === "string")
      settings[key] = { kind: "text", value: value.value };
    else if (property?.kind === "boolean" && value.kind === "boolean" && typeof value.value === "boolean")
      settings[key] = { kind: "boolean", value: value.value };
    else if (property?.kind === "choice" && value.kind === "choice" && typeof value.value === "string" &&
      property.options.some((option) => option.key === value.value))
      settings[key] = { kind: "choice", value: value.value };
    else return { kind: "invalid" };
  }
  if (validateComponentSettings(settings, release.properties).length > 0) return { kind: "invalid" };
  const seed = bridge.toPuckData(seedZone(release, alias, settings));
  if (seed.content.length !== 1) return { kind: "invalid" };
  const data = bridge.toPuckData(target.main);
  data.content.push(...seed.content);
  // Always use the real original destination. A new node's source hints cannot replace it.
  target.replace(bridge.fromPuckData(target.main, data));
  const dependencies = target.source.body.platform_block_dependencies;
  const existing = dependencies.find((dependency) => dependency.block_id === release.blockId &&
    dependency.release_version === release.releaseVersion);
  if (existing === undefined) {
    // The authoring source pins the release identity; publication records its content hash.
    dependencies.push({ kind: "platform_block", block_id: release.blockId, release_version: release.releaseVersion,
    });
    dependencies.sort((left, right) => left.block_id < right.block_id ? -1 : left.block_id > right.block_id ? 1
      : left.release_version < right.release_version ? -1 : left.release_version > right.release_version ? 1 : 0);
  }
  const source = applicationSourceDocumentSchema.parse(target.source);
  return sameValue(source, current.source) ? { kind: "invalid" } : { kind: "applied", source };
};

/** Named content settings require the actual shell reservation and fixed-slot ancestry. */
const ordinaryNamedSettingsPage = (catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument, target: Target,
  optionalLayoutAncestry = false) => {
  const page = target.region.page;
  const slotAlias = target.region.address?.slot;
  if (page === undefined || page.type === "guided_form" || slotAlias === undefined) return undefined;
  if (page.type !== "list" && page.type !== "detail" && page.type !== "dashboard") return undefined;
  const shellAlias = sourcePageShell(page.composition);
  const shells = source.body.shells.filter((shell) => shell.id === shellAlias);
  if (shells.length !== 1) return undefined;
  const shell = shells[0]!;
  const bindings = shell.content_slots.filter((binding) => binding.id === slotAlias);
  if (bindings.length !== 1 || !manifestMatches(catalogue, source, shell.layout.content)) return undefined;
  const binding = bindings[0]!;
  // Validate the complete original shell, including its required-but-empty reservations.
  toolsFor(catalogue).bridge.toPuckShell(shell);
  // Reservation validation does not validate each authored binding's metadata.
  const shellItems = new Map<string, SourceItem>();
  for (const item of sourceItemTree(shell.layout.content)) {
    if (shellItems.has(item.props.id)) return refuse();
    shellItems.set(item.props.id, item);
  }
  for (const authoredBinding of shell.content_slots) {
    const parent = shellItems.get(authoredBinding.parent_placement);
    const declarations = parent === undefined ? undefined : releaseFor(catalogue, parent)?.slots
      .filter((slot) => slot.key === authoredBinding.parent_slot);
    if (declarations?.length !== 1) return undefined;
    const declaration = declarations[0]!;
    if ((declaration.required && !authoredBinding.required) ||
      authoredBinding.allowed_child_categories.some((category) =>
        !declaration.allowedChildCategories.includes(category))) return undefined;
  }
  const parents: SourceItem[] = [];
  const optionalParentPaths: boolean[] = [];
  const visit = (items: readonly SourceItem[], optionalPath = true): void => {
    for (const item of items) {
      const release = releaseFor(catalogue, item) ?? refuse();
      if (item.props.id === binding.parent_placement) {
        parents.push(item);
        optionalParentPaths.push(optionalPath);
      }
      const slots = itemSlots(catalogue, item);
      for (const declaration of release.slots) {
        const child = slots.get(declaration.key);
        if (declaration.repeats === undefined && child !== undefined)
          visit(child.items, optionalPath && !declaration.required);
      }
    }
  };
  visit(shell.layout.content);
  if (parents.length !== 1 || parents[0] !== target.region.parent) return undefined;
  const declarations = releaseFor(catalogue, parents[0]!)?.slots.filter((slot) => slot.key === binding.parent_slot);
  if (declarations?.length !== 1 || declarations[0]!.repeats !== undefined) return undefined;
  const declaration = declarations[0]!;
  // Layout settings alone require optional immutable slots; authored required content stays required.
  if (optionalLayoutAncestry && (!optionalParentPaths[0] || declaration.required)) return undefined;
  if (target.region.zone.items.some((item) => {
    const release = releaseFor(catalogue, item);
    return release === undefined || !declaration.allowedChildCategories.includes(release.paletteGroup) ||
      !binding.allowed_child_categories.includes(release.paletteGroup);
  })) return undefined;
  return page;
};

/** Setting changes retain identity, so Flow references and required content do not block them. */
const resolveSettings = (context: StudioCompositionContext, selection: StudioSemanticSelection | null,
  eligible: (release: PlatformBlockRelease) => boolean = eligibleAddRelease) => {
  const catalogue = context.catalogue;
  const { bridge } = toolsFor(catalogue);
  plainSource(context.source);
  const resolved = resolve(context, selection);
  if (resolved === undefined) return { kind: "invalid" } as const;
  const { source, target } = resolved;
  const region = target.region;
  const release = releaseFor(catalogue, target.item);
  const layoutSettings = release !== undefined && eligibleLayoutSettingsRelease(release);
  const ordinaryPage = region.ordinaryMain === true ? region.page : undefined;
  // Settings alone may edit one actual declared step region; it never becomes an ordinary main region.
  const guidedPage = region.page?.type === "guided_form" && region.address?.slot === undefined &&
    region.page.steps.filter((step) => step.id === region.address?.step).length === 1
    ? region.page : undefined;
  const namedPage = ordinaryPage === undefined && guidedPage === undefined
    ? ordinaryNamedSettingsPage(catalogue, source, target, layoutSettings) : undefined;
  const page = ordinaryPage ?? guidedPage ?? namedPage;
  const guided = ordinaryPage === undefined && guidedPage !== undefined;
  const named = namedPage !== undefined;
  if (page === undefined || (!guided && !named &&
    ((page.type !== "list" && page.type !== "detail" && page.type !== "dashboard") ||
      region.ordinaryMain !== true)) ||
    source.body.public_addresses.some((address) => address.page === page.id) ||
    source.body.experiences?.some((experience) => experience.page === page.key)) return { kind: "unsupported" } as const;
  if (release === undefined || !eligible(release) ||
    ((guided || (named && !layoutSettings)) &&
      (release.paletteGroup !== "content" || release.slots.length !== 0)))
    return { kind: "unsupported" } as const;
  if ((!layoutSettings && itemSlots(catalogue, target.item).size !== 0) ||
    !manifestMatches(catalogue, source, region.zone.items)) return { kind: "unsupported" } as const;
  let zone = region.zone;
  for (const step of target.steps) {
    const parent = zone.items.find((item) => item.props.id === step.parentAlias);
    const declaration = parent === undefined ? undefined : releaseFor(catalogue, parent)?.slots.find((item) => item.key === step.slotKey);
    const child = parent === undefined ? undefined : itemSlots(catalogue, parent).get(step.slotKey);
    // Layout settings keep their existing children but cannot edit through required ancestor slots.
    if (declaration === undefined || declaration.repeats !== undefined || child === undefined ||
      (layoutSettings && declaration.required))
      return { kind: "unsupported" } as const;
    zone = child;
  }
  bridge.toPuckData(region.zone);
  return { kind: "available", ...resolved, release } as const;
};

const textSettings = (value: unknown, release: PlatformBlockRelease): StudioCompositionTextSettings => {
  const raw = object(value);
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => typeof key !== "string" || !release.properties.some((property) => property.key === key)))
    return refuse();
  closedPlain(raw, release.properties.filter((property) => Object.hasOwn(raw, property.key)).map((property) => property.key));
  const settings: Record<string, { kind: "text"; value: string }> = {};
  for (const key of Object.getOwnPropertyNames(raw)) {
    const text = closedPlain(raw[key], ["kind", "value"]);
    if (text.kind !== "text" || typeof text.value !== "string") return refuse();
    settings[key] = { kind: "text", value: text.value };
  }
  if (validateComponentSettings(settings, release.properties).length > 0) return refuse();
  return settings;
};

export const describeStudioCompositionSettings = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null): StudioCompositionSettingsModel => {
  try {
    const resolved = resolveSettings(context, selection);
    if (resolved.kind !== "available") return resolved;
    const properties = resolved.release.properties.map((property) => {
      if (property.kind !== "text") return refuse();
      return property;
    });
    return { kind: "available", placementAlias: resolved.alias, properties,
      settings: textSettings(itemReading(context.catalogue, resolved.target.item).settings, resolved.release) };
  } catch { return { kind: "invalid" }; }
};

const applySettings = (current: StudioCompositionContext, selection: StudioSemanticSelection | null,
  command: unknown): StudioCompositionCommandResult => {
  const { bridge } = toolsFor(current.catalogue);
  const input = closedPlain(command, ["kind", "settings"]);
  if (input.kind !== "settings") return { kind: "invalid" };
  const resolved = resolveSettings(current, selection);
  if (resolved.kind !== "available") return resolved;
  const settings = textSettings(input.settings, resolved.release);
  const { source, target, alias } = resolved;
  const data = bridge.toPuckData(target.region.zone);
  const content = privateContentAt(data.content, target.steps);
  const matches = content.filter((value) => object(object(value).props).id === alias);
  if (matches.length !== 1) return { kind: "invalid" };
  object(object(matches[0]).props).settings = structuredClone(settings);
  // Original source-order and breakpoint provenance remain the inverse's baseline.
  target.region.replace(bridge.fromPuckData(target.region.zone, data));
  const parsed = applicationSourceDocumentSchema.parse(source);
  return sameValue(parsed, current.source) ? { kind: "invalid" } : { kind: "applied", source: parsed };
};

const scalarProperties = (release: PlatformBlockRelease): readonly ScalarProperty[] =>
  release.properties.filter((property): property is ScalarProperty =>
    property.kind === "boolean" || property.kind === "choice" ||
    (release.paletteGroup === "layout" && property.kind === "number"));
const eligibleScalarRelease = (release: PlatformBlockRelease): boolean =>
  scalarProperties(release).length > 0 &&
  ((release.paletteGroup === "content" && release.slots.length === 0 && release.supportedStateOperations.length === 0 &&
    release.supportedEvents.every((event) => event === "refresh")) || eligibleLayoutSettingsRelease(release));

/** The command supplies only editable scalars; omitted keys deliberately stay omitted. */
const scalarSettings = (value: unknown, properties: readonly ScalarProperty[]): StudioCompositionScalarSettings => {
  const raw = object(value);
  closedPlain(raw, properties.filter((property) => Object.hasOwn(raw, property.key)).map((property) => property.key));
  const settings: Record<string, StudioCompositionScalarSettings[string]> = {};
  for (const property of properties) {
    if (!Object.hasOwn(raw, property.key)) continue;
    const supplied = closedPlain(raw[property.key], ["kind", "value"]);
    if (property.kind === "boolean" && supplied.kind === "boolean" && typeof supplied.value === "boolean")
      settings[property.key] = { kind: "boolean", value: supplied.value };
    else if (property.kind === "choice" && supplied.kind === "choice" && typeof supplied.value === "string" &&
      property.options.some((option) => option.key === supplied.value))
      settings[property.key] = { kind: "choice", value: supplied.value };
    else if (property.kind === "number" && supplied.kind === "number" && typeof supplied.value === "number" &&
      Number.isFinite(supplied.value))
      settings[property.key] = { kind: "number", value: supplied.value };
    else return refuse();
  }
  return settings;
};

export const describeStudioCompositionScalarSettings = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null): StudioCompositionScalarSettingsModel => {
  try {
    const resolved = resolveSettings(context, selection, eligibleScalarRelease);
    if (resolved.kind !== "available") return resolved;
    const properties = scalarProperties(resolved.release);
    const reading = itemReading(context.catalogue, resolved.target.item);
    const supplied: Record<string, unknown> = {};
    for (const property of properties)
      if (Object.hasOwn(reading.settings, property.key))
        supplied[property.key] = reading.settings[property.key];
    const settings = scalarSettings(supplied, properties);
    if (reading.settingFailures.length > 0) return { kind: "invalid" };
    return { kind: "available", placementAlias: resolved.alias, properties,
      settings };
  } catch { return { kind: "invalid" }; }
};

const applyScalarSettings = (current: StudioCompositionContext, selection: StudioSemanticSelection | null,
  command: unknown): StudioCompositionCommandResult => {
  const { bridge } = toolsFor(current.catalogue);
  const input = closedPlain(command, ["kind", "settings"]);
  if (input.kind !== "scalar_settings") return { kind: "invalid" };
  const resolved = resolveSettings(current, selection, eligibleScalarRelease);
  if (resolved.kind !== "available") return resolved;
  const properties = scalarProperties(resolved.release);
  const supplied = scalarSettings(input.settings, properties);
  const reading = itemReading(current.catalogue, resolved.target.item);
  if (reading.settingFailures.length > 0) return { kind: "invalid" };
  const settings: Record<string, SourceBlockPropertyValueContract> = { ...reading.settings };
  for (const property of properties) delete settings[property.key];
  for (const key of Object.keys(supplied)) {
    const value = supplied[key];
    if (value !== undefined) settings[key] = value;
  }
  // Validate the complete merge, including untouched structured content and required fields.
  if (validateComponentSettings(settings, resolved.release.properties).length > 0) return { kind: "invalid" };
  const { source, target, alias } = resolved;
  const data = bridge.toPuckData(target.region.zone);
  const matches = privateContentAt(data.content, target.steps).filter((value) => object(object(value).props).id === alias);
  if (matches.length !== 1) return { kind: "invalid" };
  object(object(matches[0]).props).settings = structuredClone(settings);
  target.region.replace(bridge.fromPuckData(target.region.zone, data));
  const parsed = applicationSourceDocumentSchema.parse(source);
  return sameValue(parsed, current.source) ? { kind: "invalid" } : { kind: "applied", source: parsed };
};

/** Read only declared placement identity positions, never arbitrary literal data. */
const removalReference = (source: ApplicationSourceDocument, alias: string,
  aliases: ReadonlySet<string>): StudioCompositionRemovalReason | undefined => {
  if (source.body.flow_bindings.some((binding) => binding.control === alias)) return "flow_control";
  const target = (value: unknown, qualified: boolean,
    reason: StudioCompositionRemovalReason): StudioCompositionRemovalReason | undefined => {
    if (typeof value !== "string") return "unresolved_target";
    const separator = value.indexOf(":");
    if (separator !== -1 && (!qualified || separator < 1 || value.slice(0, separator) !== source.key))
      return "unresolved_target";
    const local = value.slice(separator + 1);
    if (!applicationSourceDocumentSchema.shape.root_alias.safeParse(local).success || !aliases.has(local))
      return "unresolved_target";
    return local === alias ? reason : undefined;
  };
  const literalTarget = (value: unknown, qualified: boolean,
    reason: StudioCompositionRemovalReason): StudioCompositionRemovalReason | undefined => {
    if (!isObject(value) || value.kind !== "literal" || !isObject(value.literal) ||
      value.literal.type !== "text") return "unresolved_target";
    return target(value.literal.value, qualified, reason);
  };
  const list = (value: unknown): readonly unknown[] => {
    if (!Array.isArray(value)) return refuse();
    return value;
  };
  const definitions = Object.values(flowTaskRegistry);
  for (const flow of source.body.flows) {
    // These are authored SourceFlow lists, not the compiled Flow body's shape.
    const pending = [...flow.tasks, ...flow.errors, ...flow.finally]
      .map((task) => ({ task: object(task), depth: 1 }));
    let count = 0;
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (++count > flowMaximumTaskCount || entry.depth > flowMaximumTaskNestingDepth)
        return "unresolved_target";
      const task = entry.task;
      const definition = definitions.find((candidate) => candidate.type === task.type);
      if (definition === undefined) return "unresolved_target";
      const children: (readonly unknown[])[] = [];
      if (definition.category === "control") {
        switch (task.type) {
          case "if":
            children.push(list(task.then));
            if (task.else !== undefined) children.push(list(task.else));
            break;
          case "switch":
            for (const branch of list(task.cases)) children.push(list(object(branch).tasks));
            if (task.default !== undefined) children.push(list(task.default));
            break;
          case "for_each": case "sequential": children.push(list(task.tasks)); break;
          case "parallel":
            for (const branch of list(task.branches)) children.push(list(branch));
            break;
          case "wait_for_person": {
            const blocked = target(task.formId, true, "flow_form");
            if (blocked !== undefined) return blocked;
            break;
          }
          case "run_flow": case "stop": case "wait_until": break;
          default: return "unresolved_target";
        }
      } else {
        if (task.version !== definition.version || !isObject(task.properties)) return "unresolved_target";
        for (const [key, declaration] of Object.entries(definition.properties)) {
          const reason = declaration.type === "form_id" ? "flow_form"
            : (task.type === "interface.refresh" || task.type === "interface.set_filter") && key === "component"
              ? "flow_component" : task.type === "interface.set_panel" && key === "panel" ? "flow_panel" : undefined;
          if (reason === undefined) continue;
          const value = task.properties[key];
          if (value === undefined && !declaration.required) continue;
          const blocked = literalTarget(value, declaration.type === "form_id", reason);
          if (blocked !== undefined) return blocked;
        }
      }
      for (const child of children) for (const nested of child)
        pending.push({ task: object(nested), depth: entry.depth + 1 });
    }
  }
  return undefined;
};

type Removal = {
  source: ApplicationSourceDocument; target: Target; alias: string;
  willRemoveUnusedRelease: boolean;
};
type ResolvedRemoval = { kind: "available"; removal: Removal }
  | Exclude<StudioCompositionRemovalModel, { kind: "available" }>;
const resolveRemoval = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null): ResolvedRemoval => {
  const catalogue = context.catalogue;
  const { bridge } = toolsFor(catalogue);
  plainSource(context.source);
  const resolved = resolve(context, selection);
  if (resolved === undefined) return { kind: "invalid" };
  const { source, target, alias } = resolved;
  const page = target.region.ordinaryMain === true ? target.region.page : undefined;
  if (page === undefined || (page.type !== "list" && page.type !== "detail" && page.type !== "dashboard") ||
    source.body.public_addresses.some((address) => address.page === page.id) ||
    source.body.experiences?.some((experience) => experience.page === page.key)) return { kind: "unsupported" };
  const release = releaseFor(catalogue, target.item);
  if (release === undefined || !eligibleAddRelease(release) || itemSlots(catalogue, target.item).size !== 0 ||
    !manifestMatches(catalogue, source, target.region.zone.items)) return { kind: "unsupported" };
  bridge.toPuckData(target.region.zone);
  let zone = target.region.zone;
  for (const step of target.steps) {
    const parent = zone.items.find((item) => item.props.id === step.parentAlias);
    const declaration = parent === undefined ? undefined : releaseFor(catalogue, parent)?.slots.find((item) => item.key === step.slotKey);
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
  const reason = removalReference(source, alias, aliases);
  return reason === undefined ? { kind: "available", removal: {
    source, target, alias, willRemoveUnusedRelease: releaseUses === 1,
  } } : { kind: "blocked", reason };
};

export const describeStudioCompositionRemoval = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null): StudioCompositionRemovalModel => {
  try {
    const resolved = resolveRemoval(context, selection);
    return resolved.kind === "available" ? { kind: "available", placementAlias: resolved.removal.alias,
      willRemoveUnusedRelease: resolved.removal.willRemoveUnusedRelease } : resolved;
  } catch { return { kind: "invalid" }; }
};

const applyRemoval = (current: StudioCompositionContext, selection: StudioSemanticSelection | null,
  command: unknown): StudioCompositionCommandResult => {
  const { bridge } = toolsFor(current.catalogue);
  closedPlain(command, ["kind"]);
  const resolved = resolveRemoval(current, selection);
  if (resolved.kind !== "available") return { kind: resolved.kind === "invalid" ? "invalid" : "unsupported" };
  const { source, target, alias, willRemoveUnusedRelease } = resolved.removal;
  const data = bridge.toPuckData(target.region.zone);
  const content = privateContentAt(data.content, target.steps);
  const index = content.findIndex((value) => object(object(value).props).id === alias);
  if (index < 0) return { kind: "invalid" };
  content.splice(index, 1);
  // The original destination supplies order/provenance, including explicit empty breakpoints.
  target.region.replace(bridge.fromPuckData(target.region.zone, data));
  const block = target.item.props.vortex.block;
  if (willRemoveUnusedRelease) source.body.platform_block_dependencies = source.body.platform_block_dependencies
    .filter((dependency) => dependency.block_id !== block.block_id ||
      dependency.release_version !== block.release_version);
  const parsed = applicationSourceDocumentSchema.parse(source);
  return sameValue(parsed, current.source) ? { kind: "invalid" } : { kind: "applied", source: parsed };
};

export const describeStudioCompositionDestinations = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null): StudioCompositionDestinationModel => {
  try {
    const resolved = resolve(context, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const catalogue = context.catalogue;
    const { bridge } = toolsFor(catalogue);
    const { target, source, alias } = resolved;
    if (target.region.ordinaryMain !== true || !manifestMatches(catalogue, source, target.region.zone.items))
      return { kind: "unsupported" };
    bridge.toPuckData(target.region.zone);
    return { kind: "available", destinations: moveDestinations(catalogue, target, alias).map(({ destination, label }) =>
      ({ destination, label })) };
  } catch { return { kind: "invalid" }; }
};

export const describeStudioCompositionEdit = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null, breakpoint: StudioCompositionBreakpoint): StudioCompositionEditorModel => {
  try {
    if (!breakpointValid(breakpoint)) return { kind: "invalid" };
    const resolved = resolve(context, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const catalogue = context.catalogue;
    const { bridge } = toolsFor(catalogue);
    const { target, source, alias } = resolved;
    if (!manifestMatches(catalogue, source, target.region.zone.items) ||
      (target.region.parent !== undefined && !pinnedRelease(catalogue, source, target.region.parent)))
      return { kind: "unsupported" };
    // Validate the complete original region and reserved shell targets before offering controls.
    if (target.region.shell) bridge.toPuckShell(target.region.shell);
    else bridge.toPuckData(target.region.zone);
    const release = releaseFor(catalogue, target.item);
    if (release === undefined) return { kind: "unsupported" };
    const responsive = target.item.props.vortex.responsive;
    return { kind: "available", placementAlias: alias,
      order: [...sourceSlotBreakpointOrders(target.zone.items, target.zone.order)[breakpoint]],
      explicitOrder: breakpoint === "desktop" || target.zone.order?.[breakpoint] !== undefined,
      responsiveOrder: target.responsiveOrder,
      layout: structuredClone(effective(responsive, breakpoint)),
      explicitLayout: responsive[breakpoint] !== undefined,
      capabilities: { gridWidth: release.capabilities.gridWidth, height: release.capabilities.height,
        responsiveVisibility: release.capabilities.responsiveVisibility } };
  } catch { return { kind: "invalid" }; }
};

/** Return one whole native source. The workspace rechecks this context before one history.edit. */
export const applyStudioCompositionCommand = (current: StudioCompositionContext,
  expected: StudioCompositionContext, selection: StudioSemanticSelection | null,
  command: StudioCompositionCommand): StudioCompositionCommandResult => {
  try {
    if (!sameContext(expected, current)) return { kind: "stale" };
    const catalogue = current.catalogue;
    const { bridge } = toolsFor(catalogue);
    const kind = Object.getOwnPropertyDescriptor(command, "kind");
    if (kind === undefined || kind.get !== undefined || kind.set !== undefined) return { kind: "invalid" };
    if (command.kind === "add") return applyAdd(current, selection, command);
    if (command.kind === "remove") return applyRemoval(current, selection, command);
    if (command.kind === "settings") return applySettings(current, selection, command);
    if (command.kind === "scalar_settings") return applyScalarSettings(current, selection, command);
    const resolved = resolve(current, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const { source, target, alias } = resolved;
    if (!manifestMatches(catalogue, source, target.region.zone.items) ||
      (target.region.parent !== undefined && !pinnedRelease(catalogue, source, target.region.parent)))
      return { kind: "unsupported" };
    if (command.kind === "move") {
      closedPlain(command, ["kind", "destination"]);
      if (target.region.ordinaryMain !== true) return { kind: "unsupported" };
      const destination = parseDestination(command.destination);
      const resolvedDestination = moveDestinations(catalogue, target, alias).find((candidate) =>
        sameDestination(candidate.destination, destination));
      if (resolvedDestination === undefined) return { kind: "invalid" };
      const data = bridge.toPuckData(target.region.zone);
      const from = privateContentAt(data.content, target.steps);
      const to = privateContentAt(data.content, resolvedDestination.steps);
      const index = from.findIndex((value: unknown) => object(object(value).props).id === alias);
      if (index < 0 || from === to) return { kind: "invalid" };
      // Transfer the whole original private node. Its source-origin order hints
      // must never be rewritten to impersonate the destination baseline.
      const moved = from.splice(index, 1)[0];
      if (moved === undefined) return refuse();
      to.push(moved);
      target.region.replace(bridge.fromPuckData(target.region.zone, data));
      const parsed = applicationSourceDocumentSchema.parse(source);
      return sameValue(parsed, current.source) ? { kind: "invalid" } : { kind: "applied", source: parsed };
    }
    if (!breakpointValid(command.breakpoint)) return { kind: "invalid" };
    const commandKeys = Reflect.ownKeys(command);
    const allowedKeys = command.kind === "order" ? ["kind", "breakpoint", "order"] : ["kind", "breakpoint", "layout"];
    if (commandKeys.length !== 3 || commandKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)))
      return { kind: "invalid" };
    const data = target.region.shell ? bridge.toPuckShell(target.region.shell) : bridge.toPuckData(target.region.zone);
    let content: unknown = data.content;
    for (const step of target.steps) {
      if (!Array.isArray(content)) return refuse();
      const parent: unknown = content.find((value: unknown) => object(object(value).props).id === step.parentAlias);
      content = object(object(parent).props)[step.slotKey];
    }
    if (!Array.isArray(content)) return refuse();
    if (command.kind === "order") {
      if (command.breakpoint !== "desktop" && !target.responsiveOrder) return { kind: "unsupported" };
      const desktop = target.zone.items.map((item) => item.props.id);
      const order: { desktop: string[]; tablet?: string[]; phone?: string[] } = {
        desktop,
        ...(target.zone.order?.tablet === undefined ? {} : { tablet: [...target.zone.order.tablet] }),
        ...(target.zone.order?.phone === undefined ? {} : { phone: [...target.zone.order.phone] }),
      };
      if (command.order === null) {
        if (command.breakpoint === "desktop") return { kind: "invalid" };
        delete order[command.breakpoint];
      } else {
        if (!Array.isArray(command.order)) return { kind: "invalid" };
        const proposed: unknown[] = [...command.order];
        // The order must name every item of this slot exactly once.
        if (proposed.length !== desktop.length || new Set(proposed).size !== proposed.length ||
          proposed.some((id) => typeof id !== "string" || !desktop.includes(id)))
          return { kind: "invalid" };
        order[command.breakpoint] = proposed as string[];
      }
      if (command.breakpoint === "desktop") {
        // A release without responsive order applies the same order at every
        // breakpoint; retain explicit declarations while moving their values.
        if (!target.responsiveOrder) {
          if (order.tablet !== undefined) order.tablet = [...order.desktop];
          if (order.phone !== undefined) order.phone = [...order.desktop];
        }
        const byId = new Map(content.map((value: unknown) => [object(object(value).props).id, value]));
        content.splice(0, content.length, ...order.desktop.map((id) => byId.get(id)));
      }
      for (const value of content) {
        const nodeProps = object(object(value).props);
        // Mutate the actual private metadata, retaining its slot/baselineOrder provenance.
        const metadata = object(nodeProps.vortex);
        metadata.order = structuredClone(order);
        nodeProps.vortex = metadata;
      }
    } else if (command.kind === "resize") {
      const responsive = { ...target.item.props.vortex.responsive };
      if (command.layout === null) {
        if (command.breakpoint === "desktop") return { kind: "invalid" };
        delete responsive[command.breakpoint];
      } else {
        const checked = sourcePlacementLayoutSchema.safeParse(command.layout);
        if (!checked.success) return { kind: "invalid" };
        responsive[command.breakpoint] = checked.data;
      }
      const node: unknown = content.find((value: unknown) => object(object(value).props).id === alias);
      const props = object(object(node).props);
      // Drop Puck's copy of the old layout: the adapter would read a stale copy that differs
      // from the authored layout as a Puck edit and write the old layout back.
      const metadata = { ...object(props.vortex) };
      delete metadata.responsive;
      const authored = object(metadata.authored);
      props.vortex = {
        ...metadata,
        authored: { ...authored, responsive: structuredClone(responsive) },
      };
    } else return { kind: "invalid" };
    if (target.region.shell) {
      const shell = bridge.fromPuckShell(target.region.shell, data);
      target.region.replace({ items: shell.layout.content,
        order: shell.layout.root.props.vortex.slot_orders.content }, shell);
    } else target.region.replace(bridge.fromPuckData(target.region.zone, data));
    const parsed = applicationSourceDocumentSchema.parse(source);
    if (sameValue(parsed, current.source)) return { kind: "invalid" };
    return { kind: "applied", source: parsed };
  } catch { return { kind: "invalid" }; }
};
