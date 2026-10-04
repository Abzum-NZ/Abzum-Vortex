import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  applicationRootIdSchema,
  applicationSourceDocumentV2Schema,
  organizationIdSchema,
  sourcePlacementLayoutV2Schema,
  sourcePlacementSlotV2Schema,
  type ApplicationRootId,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";
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
  | Readonly<{ kind: "resize"; breakpoint: StudioCompositionBreakpoint; layout: StudioCompositionLayout | null }>;

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
        result.push({ slot: ordinary.main, replace: (replacement) => { ordinary.main = replacement; } });
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
    if (!breakpointValid(command.breakpoint)) return { kind: "invalid" };
    const resolved = resolve(current, selection);
    if (resolved === undefined) return { kind: "invalid" };
    const { source, target, alias } = resolved;
    if (!manifestMatches(source, target.region.slot) ||
      (target.region.parent !== undefined && !pinnedRelease(source, target.region.parent)))
      return { kind: "unsupported" };
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
