import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  applicationRootIdSchema,
  applicationSourceDocumentV2Schema,
  organizationIdSchema,
  sourceAliasSchema,
  sourcePlacementLayoutV2Schema,
  sourcePlacementSlotV2Schema,
  type ApplicationRootId,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type BlockPropertySchemaV2Contract,
} from "@vortex/contracts";
import { createStudioDiscoveryAdapter } from "./discovery-adapter";
import { getStudioContextualPaletteGroups } from "./contextual-palette";
import { createVortexAuthoredPuckAdapterV2 } from "./vortex-authored-puck-adapter";
import { resolveStudioSelectionInspectorContext } from "./selection-inspector";
import type { StudioSemanticSelection } from "./semantic-selection";

export type StudioCompositionBreakpoint = "desktop" | "tablet" | "phone";
export type StudioCompositionLayout = ReturnType<typeof sourcePlacementLayoutV2Schema.parse>;
type SourceSlot = ReturnType<typeof sourcePlacementSlotV2Schema.parse>;
type SourcePlacement = SourceSlot["placements"][string];
type SourceShell = ApplicationSourceDocumentV2["body"]["shells"][number];

/** Local identity only: a command does not grant authority or perform a write. */
export type StudioCompositionContext = Readonly<{
  organizationId: string;
  rootId: ApplicationRootId;
  key: string;
  draftRevision: number;
  localLifetime: number;
  source: Readonly<ApplicationSourceDocumentV2>;
}>;

export type StudioCompositionCommand =
  | Readonly<{ kind: "order"; breakpoint: StudioCompositionBreakpoint; order: readonly string[] | null }>
  | Readonly<{ kind: "resize"; breakpoint: StudioCompositionBreakpoint; layout: StudioCompositionLayout | null }>
  | Readonly<{ kind: "move"; destination: StudioCompositionDestination }>
  | Readonly<{ kind: "add"; blockId: string; releaseVersion: string; alias: string;
      settings: StudioCompositionTextSettings }>;

export type StudioCompositionTextSettings = Readonly<Record<string, Readonly<{ kind: "text"; value: string }>>>;
export type StudioCompositionPaletteChoice = Readonly<{
  id: string; blockId: string; releaseVersion: string; key: string; name: string;
  properties: readonly Extract<BlockPropertySchemaV2Contract, { kind: "text" }>[];
}>;
export type StudioCompositionPaletteModel =
  | Readonly<{ kind: "available"; choices: readonly StudioCompositionPaletteChoice[] }>
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
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocumentV2 }>
  | Readonly<{ kind: "invalid" | "stale" | "unsupported" }>;

export type StudioCompositionEditorModel =
  | Readonly<{
      kind: "available";
      placementAlias: string;
      order: readonly string[];
      explicitOrder: boolean;
      responsiveOrder: boolean;
      layout: StudioCompositionLayout;
      explicitLayout: boolean;
      capabilities: Readonly<Pick<PlatformBlockReleaseV2["capabilities"],
        "gridWidth" | "height" | "responsiveVisibility">>;
    }>
  | Readonly<{ kind: "invalid" | "unsupported" }>;

type Region = {
  slot: SourceSlot;
  ordinaryMain?: boolean;
  shell?: SourceShell;
  parent?: SourcePlacement;
  replace: (slot: SourceSlot, shell?: SourceShell) => void;
};
type SlotStep = Readonly<{ parentAlias: string; slotKey: string }>;
type Target = { region: Region; slot: SourceSlot; placement: SourcePlacement;
  steps: readonly SlotStep[]; responsiveOrder: boolean };

const catalogue = IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2;
const bridge = createVortexAuthoredPuckAdapterV2(catalogue);
const releases = new Map(catalogue.releases.map((release) =>
  [`${release.blockId}:${release.releaseVersion}`, release]));
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
  expected.localLifetime === current.localLifetime && expected.source === current.source;

/** Enumerate native regions; a caller cannot supply a JSON pointer or a guessed step id. */
const regions = (source: ApplicationSourceDocumentV2): Region[] => {
  const result: Region[] = source.body.shells.map((shell) => ({
    slot: shell.layout, shell, replace: (slot: SourceSlot, replacement?: SourceShell) => {
      shell.layout = replacement?.layout ?? slot;
    },
  }));
  const customParent = (shellAlias: string, slotAlias: string): SourcePlacement => {
    const shell = source.body.shells.find((item) => item.id === shellAlias) ?? refuse();
    const binding = shell.content_slots.find((item) => item.id === slotAlias) ?? refuse();
    const find = (slot: SourceSlot): SourcePlacement | undefined => {
      if (slot.placements[binding.parent_placement]) return slot.placements[binding.parent_placement];
      for (const placement of Object.values(slot.placements))
        for (const child of Object.values(placement.slots)) {
          const match = find(child);
          if (match) return match;
        }
      return undefined;
    };
    return find(shell.layout) ?? refuse();
  };
  for (const page of source.body.pages) {
    if (page.type === "guided_form") {
      const guided = page.composition;
      if (guided.shell_kind === "default") {
        for (const [step, slot] of Object.entries(guided.step_content))
          result.push({ slot, replace: (replacement) => { guided.step_content[step] = replacement; } });
      } else {
        for (const content of Object.values(guided.step_content))
          for (const [alias, slot] of Object.entries(content))
            result.push({ slot, parent: customParent(guided.shell, alias),
              replace: (replacement) => { content[alias] = replacement; } });
      }
    } else if (page.composition.shell_kind === "default") {
      // The discriminated page is used here so guided step content cannot be inferred.
      const ordinary = page.composition;
      if (ordinary.shell_kind === "default")
        result.push({ slot: ordinary.main, ordinaryMain: true,
          replace: (replacement) => { ordinary.main = replacement; } });
    } else {
      const ordinary = page.composition;
      if (ordinary.shell_kind === "application")
        for (const [alias, slot] of Object.entries(ordinary.content))
          result.push({ slot, parent: customParent(ordinary.shell, alias),
            replace: (replacement) => { ordinary.content[alias] = replacement; } });
    }
  }
  return result;
};

const releaseFor = (placement: SourcePlacement): PlatformBlockReleaseV2 | undefined =>
  releases.get(`${placement.block.block_id}:${placement.block.release_version}`);

const targetFor = (source: ApplicationSourceDocumentV2, alias: string): Target | undefined => {
  const matches: Target[] = [];
  for (const region of regions(source)) {
    let count = 0;
    const visit = (slot: SourceSlot, steps: readonly SlotStep[], responsiveOrder: boolean): void => {
      if (steps.length >= catalogue.compositionPolicy.maximumDepth && Object.keys(slot.placements).length > 0)
        return refuse();
      for (const [id, placement] of Object.entries(slot.placements)) {
        if (++count > catalogue.compositionPolicy.maximumPlacements) return refuse();
        if (id === alias) matches.push({ region, slot, placement, steps, responsiveOrder });
        for (const [slotKey, child] of Object.entries(placement.slots))
          visit(child, [...steps, { parentAlias: id, slotKey }],
            releaseFor(placement)?.capabilities.responsiveOrder === true);
      }
    };
    visit(region.slot, [], region.parent === undefined ||
      releaseFor(region.parent)?.capabilities.responsiveOrder === true);
  }
  return matches.length === 1 ? matches[0] : undefined;
};

/** Only the selected region needs supported releases; unrelated regions remain untouched. */
const pinnedRelease = (source: ApplicationSourceDocumentV2, placement: SourcePlacement): boolean => {
  const release = releaseFor(placement);
  return release !== undefined && source.body.platform_block_dependencies.some((dependency) =>
    dependency.block_id === release.blockId && dependency.release_version === release.releaseVersion &&
    dependency.content_fingerprint === release.contentFingerprint &&
    dependency.catalogue_fingerprint === release.catalogueFingerprint);
};
const manifestMatches = (source: ApplicationSourceDocumentV2, slot: SourceSlot): boolean => {
  for (const placement of Object.values(slot.placements)) {
    if (!pinnedRelease(source, placement)) return false;
    for (const child of Object.values(placement.slots))
      if (!manifestMatches(source, child)) return false;
  }
  return true;
};

const resolve = (context: StudioCompositionContext, selection: StudioSemanticSelection | null) => {
  if (!validContext(context) || selection?.kind !== "placement") return undefined;
  const source = applicationSourceDocumentV2Schema.parse(context.source);
  if (resolveStudioSelectionInspectorContext({ rootId: context.rootId, source }, selection).status !== "resolved")
    return undefined;
  const target = targetFor(source, selection.placementAlias);
  return target === undefined ? undefined : { source, target, alias: selection.placementAlias };
};

type MoveDestination = {
  destination: StudioCompositionDestination; label: string; steps: readonly SlotStep[];
};
const sameSteps = (left: readonly SlotStep[], right: readonly SlotStep[]): boolean =>
  left.length === right.length && left.every((step, index) =>
    step.parentAlias === right[index]?.parentAlias && step.slotKey === right[index]?.slotKey);

/** Only actual non-repeatable slots in this original ordinary region are destinations. */
const moveDestinations = (target: Target, alias: string): MoveDestination[] => {
  if (target.region.ordinaryMain !== true) return [];
  const subtree = new Set<string>([alias]);
  const descendants = (slot: SourceSlot): void => {
    for (const [id, placement] of Object.entries(slot.placements)) {
      subtree.add(id);
      for (const child of Object.values(placement.slots)) descendants(child);
    }
  };
  for (const child of Object.values(target.placement.slots)) descendants(child);
  const movedRelease = releaseFor(target.placement) ?? refuse();
  const result: MoveDestination[] = [];
  let selectedPathSupported = target.steps.length === 0;
  const visit = (slot: SourceSlot, steps: readonly SlotStep[]): void => {
    if (sameSteps(steps, target.steps)) selectedPathSupported = true;
    for (const [parentAlias, placement] of Object.entries(slot.placements)) {
      if (subtree.has(parentAlias)) continue;
      const release = releaseFor(placement) ?? refuse();
      for (const declaration of release.slots) {
        if (declaration.repeats !== undefined) continue;
        const child = placement.slots[declaration.key];
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
    label: "This page's main region", steps: [] });
  visit(target.region.slot, []);
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
    content = object(object(matches[0]).props)[`slot_${step.slotKey}`];
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

const eligibleAddRelease = (release: PlatformBlockReleaseV2): boolean =>
  release.paletteGroup === "content" && release.slots.length === 0 &&
  release.properties.every((property) => property.kind === "text" && !property.required) &&
  release.capabilities.accessibleName === "optional" && release.supportedStateOperations.length === 0 &&
  release.supportedEvents.every((event) => event === "refresh");

type AddTarget =
  | { kind: "available"; source: ApplicationSourceDocumentV2; main: SourceSlot; replace: (slot: SourceSlot) => void }
  | { kind: "invalid" | "unsupported" };
const resolveAdd = (context: StudioCompositionContext, selection: StudioSemanticSelection | null): AddTarget => {
  if (selection?.kind !== "page") return { kind: "invalid" };
  plainSource(context.source);
  if (!validContext(context)) return { kind: "invalid" };
  // Bound and validate the actual selected raw region before the recursive whole-source schema.
  const rawPages = object(object(context.source).body).pages;
  if (!Array.isArray(rawPages)) return { kind: "invalid" };
  const rawMatches = rawPages.filter((page: unknown) => object(page).id === selection.pageAlias);
  if (rawMatches.length !== 1) return { kind: "invalid" };
  const rawPage = object(rawMatches[0]);
  const rawComposition = object(rawPage.composition);
  if (rawPage.type === "public" || rawPage.type === "guided_form" || rawComposition.shell_kind !== "default")
    return { kind: "unsupported" };
  bridge.toPuckData(rawComposition.main);
  const source = applicationSourceDocumentV2Schema.parse(context.source);
  if (resolveStudioSelectionInspectorContext({ rootId: context.rootId, source }, selection).status !== "resolved")
    return { kind: "invalid" };
  const pages = source.body.pages.filter((page) => page.id === selection.pageAlias);
  const page = pages.length === 1 ? pages[0] : undefined;
  if (page === undefined) return { kind: "invalid" };
  if (page.type === "public" || page.type === "guided_form" || page.composition.shell_kind !== "default")
    return { kind: "unsupported" };
  const composition = page.composition;
  if (!manifestMatches(source, composition.main)) return { kind: "unsupported" };
  return { kind: "available", source, main: composition.main,
    replace: (slot) => { composition.main = slot; } };
};

const addChoices = (searchText: string, authoredAlias: string): StudioCompositionPaletteChoice[] => {
  // This surface describes an already resolved nonpublic page; it grants no authority.
  const discovery = createStudioDiscoveryAdapter({ catalogue, surface: { kind: "authenticated" } });
  return getStudioContextualPaletteGroups(discovery, { kind: "page" }, searchText)
    .flatMap((group) => group.choices).flatMap((choice) => {
      const release = releases.get(`${choice.blockId}:${choice.releaseVersion}`);
      if (release === undefined || !eligibleAddRelease(release)) return [];
      const properties = release.properties.map((property) => {
        if (property.kind !== "text") return refuse();
        return property;
      });
      // Optional declarations must really accept omission and the native seed.
      // Validation uses an existing authored alias or the user's proposed alias,
      // never a generated placement identity. This detached seed is not persisted.
      bridge.toPuckData(seedSlot(release, authoredAlias, {}));
      return [{ id: choice.id, blockId: release.blockId, releaseVersion: release.releaseVersion,
        key: release.key, name: release.name, properties }];
    });
};

const seedSlot = (release: PlatformBlockReleaseV2, alias: string,
  settings: StudioCompositionTextSettings): SourceSlot => ({
  placements: { [alias]: {
    block: { block_id: release.blockId, release_version: release.releaseVersion },
    settings: structuredClone(settings), theme_overrides: {}, slots: {},
    responsive: { desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } } },
  } }, order: { desktop: [alias] },
});

export const describeStudioCompositionPalette = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null, searchText = ""): StudioCompositionPaletteModel => {
  try {
    if (selection?.kind !== "page") return { kind: "invalid" };
    const target = resolveAdd(context, selection);
    return target.kind === "available" ? { kind: "available", choices: addChoices(searchText, selection.pageAlias) } : target;
  } catch { return { kind: "invalid" }; }
};

const applyAdd = (current: StudioCompositionContext, selection: StudioSemanticSelection | null,
  command: unknown): StudioCompositionCommandResult => {
  const input = closedPlain(command, ["kind", "blockId", "releaseVersion", "alias", "settings"]);
  if (input.kind !== "add" || typeof input.blockId !== "string" || typeof input.releaseVersion !== "string")
    return { kind: "invalid" };
  const alias = sourceAliasSchema.parse(input.alias);
  const target = resolveAdd(current, selection);
  if (target.kind !== "available") return target;
  const release = releases.get(`${input.blockId}:${input.releaseVersion}`);
  if (release === undefined || !eligibleAddRelease(release) ||
    !addChoices("", alias).some((choice) => choice.blockId === input.blockId && choice.releaseVersion === input.releaseVersion))
    return { kind: "unsupported" };
  const allSlots = regions(target.source).map((region) => region.slot);
  while (allSlots.length > 0) {
    const slot = allSlots.pop()!;
    if (Object.hasOwn(slot.placements, alias)) return { kind: "invalid" };
    for (const placement of Object.values(slot.placements)) allSlots.push(...Object.values(placement.slots));
  }
  const rawSettings = object(input.settings);
  const settingKeys = Reflect.ownKeys(rawSettings);
  if (settingKeys.some((key) => typeof key !== "string" || !release.properties.some((property) => property.key === key)))
    return { kind: "invalid" };
  closedPlain(rawSettings, release.properties.filter((property) => Object.hasOwn(rawSettings, property.key))
    .map((property) => property.key));
  const settings: Record<string, { kind: "text"; value: string }> = {};
  for (const key of Object.getOwnPropertyNames(rawSettings)) {
    const text = closedPlain(rawSettings[key], ["kind", "value"]);
    if (text.kind !== "text" || typeof text.value !== "string") return { kind: "invalid" };
    settings[key] = { kind: "text", value: text.value };
  }
  const seed = bridge.toPuckData(seedSlot(release, alias, settings));
  if (seed.content.length !== 1) return { kind: "invalid" };
  const data = bridge.toPuckData(target.main);
  data.content.push(...seed.content);
  // Always use the real original destination. A new node's source hints cannot replace it.
  target.replace(bridge.fromPuckData(target.main, data));
  const dependencies = target.source.body.platform_block_dependencies;
  const existing = dependencies.find((dependency) => dependency.block_id === release.blockId &&
    dependency.release_version === release.releaseVersion);
  if (existing !== undefined) {
    if (existing.content_fingerprint !== release.contentFingerprint ||
      existing.catalogue_fingerprint !== release.catalogueFingerprint) return { kind: "invalid" };
  } else {
    dependencies.push({ kind: "platform_block", block_id: release.blockId, release_version: release.releaseVersion,
      content_fingerprint: release.contentFingerprint, catalogue_fingerprint: release.catalogueFingerprint });
    dependencies.sort((left, right) => left.block_id < right.block_id ? -1 : left.block_id > right.block_id ? 1
      : left.release_version < right.release_version ? -1 : left.release_version > right.release_version ? 1 : 0);
  }
  const source = applicationSourceDocumentV2Schema.parse(target.source);
  return sameValue(source, current.source) ? { kind: "invalid" } : { kind: "applied", source };
};

export const describeStudioCompositionDestinations = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null): StudioCompositionDestinationModel => {
  try {
    const resolved = resolve(context, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const { target, source, alias } = resolved;
    if (target.region.ordinaryMain !== true || !manifestMatches(source, target.region.slot))
      return { kind: "unsupported" };
    bridge.toPuckData(target.region.slot);
    return { kind: "available", destinations: moveDestinations(target, alias).map(({ destination, label }) =>
      ({ destination, label })) };
  } catch { return { kind: "invalid" }; }
};

export const describeStudioCompositionEdit = (context: StudioCompositionContext,
  selection: StudioSemanticSelection | null, breakpoint: StudioCompositionBreakpoint): StudioCompositionEditorModel => {
  try {
    if (!breakpointValid(breakpoint)) return { kind: "invalid" };
    const resolved = resolve(context, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const { target, source, alias } = resolved;
    if (!manifestMatches(source, target.region.slot) ||
      (target.region.parent !== undefined && !pinnedRelease(source, target.region.parent)))
      return { kind: "unsupported" };
    // Validate the complete original region and reserved shell targets before offering controls.
    if (target.region.shell) bridge.toPuckShell(target.region.shell);
    else bridge.toPuckData(target.region.slot);
    const release = releaseFor(target.placement);
    if (release === undefined) return { kind: "unsupported" };
    return { kind: "available", placementAlias: alias,
      order: [...effective(target.slot.order, breakpoint)],
      explicitOrder: target.slot.order[breakpoint] !== undefined,
      responsiveOrder: target.responsiveOrder,
      layout: structuredClone(effective(target.placement.responsive, breakpoint)),
      explicitLayout: target.placement.responsive[breakpoint] !== undefined,
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
    const kind = Object.getOwnPropertyDescriptor(command, "kind");
    if (kind === undefined || kind.get !== undefined || kind.set !== undefined) return { kind: "invalid" };
    if (command.kind === "add") return applyAdd(current, selection, command);
    const resolved = resolve(current, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const { source, target, alias } = resolved;
    if (!manifestMatches(source, target.region.slot) ||
      (target.region.parent !== undefined && !pinnedRelease(source, target.region.parent)))
      return { kind: "unsupported" };
    if (command.kind === "move") {
      closedPlain(command, ["kind", "destination"]);
      if (target.region.ordinaryMain !== true) return { kind: "unsupported" };
      const destination = parseDestination(command.destination);
      const resolvedDestination = moveDestinations(target, alias).find((candidate) =>
        sameDestination(candidate.destination, destination));
      if (resolvedDestination === undefined) return { kind: "invalid" };
      const data = bridge.toPuckData(target.region.slot);
      const from = privateContentAt(data.content, target.steps);
      const to = privateContentAt(data.content, resolvedDestination.steps);
      const index = from.findIndex((value: unknown) => object(object(value).props).id === alias);
      if (index < 0 || from === to) return { kind: "invalid" };
      // Transfer the whole original private node. Its source-origin order hints
      // must never be rewritten to impersonate the destination baseline.
      const moved = from.splice(index, 1)[0];
      if (moved === undefined) return refuse();
      to.push(moved);
      target.region.replace(bridge.fromPuckData(target.region.slot, data));
      const parsed = applicationSourceDocumentV2Schema.parse(source);
      return sameValue(parsed, current.source) ? { kind: "invalid" } : { kind: "applied", source: parsed };
    }
    if (!breakpointValid(command.breakpoint)) return { kind: "invalid" };
    const commandKeys = Reflect.ownKeys(command);
    const allowedKeys = command.kind === "order" ? ["kind", "breakpoint", "order"] : ["kind", "breakpoint", "layout"];
    if (commandKeys.length !== 3 || commandKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)))
      return { kind: "invalid" };
    const data = target.region.shell ? bridge.toPuckShell(target.region.shell) : bridge.toPuckData(target.region.slot);
    let content: unknown = data.content;
    for (const step of target.steps) {
      if (!Array.isArray(content)) return refuse();
      const parent: unknown = content.find((value: unknown) => object(object(value).props).id === step.parentAlias);
      content = object(object(parent).props)[`slot_${step.slotKey}`];
    }
    if (!Array.isArray(content)) return refuse();
    if (command.kind === "order") {
      if (command.breakpoint !== "desktop" && !target.responsiveOrder) return { kind: "unsupported" };
      const order = { ...target.slot.order };
      if (command.order === null) {
        if (command.breakpoint === "desktop") return { kind: "invalid" };
        delete order[command.breakpoint];
      } else {
        if (!Array.isArray(command.order)) return { kind: "invalid" };
        const checked = sourcePlacementSlotV2Schema.safeParse({ placements: target.slot.placements,
          order: { desktop: [...command.order] } });
        if (!checked.success) return { kind: "invalid" };
        order[command.breakpoint] = [...command.order];
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
      const responsive = { ...target.placement.responsive };
      if (command.layout === null) {
        if (command.breakpoint === "desktop") return { kind: "invalid" };
        delete responsive[command.breakpoint];
      } else {
        const checked = sourcePlacementLayoutV2Schema.safeParse(command.layout);
        if (!checked.success) return { kind: "invalid" };
        responsive[command.breakpoint] = checked.data;
      }
      const node: unknown = content.find((value: unknown) => object(object(value).props).id === alias);
      const props = object(object(node).props);
      props.vortex = { ...object(props.vortex), responsive };
    } else return { kind: "invalid" };
    if (target.region.shell) {
      const shell = bridge.fromPuckShell(target.region.shell, data);
      target.region.replace(shell.layout, shell);
    } else target.region.replace(bridge.fromPuckData(target.region.slot, data));
    const parsed = applicationSourceDocumentV2Schema.parse(source);
    if (sameValue(parsed, current.source)) return { kind: "invalid" };
    return { kind: "applied", source: parsed };
  } catch { return { kind: "invalid" }; }
};
