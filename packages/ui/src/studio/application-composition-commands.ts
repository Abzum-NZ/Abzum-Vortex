import {
  sameCompositionValue as sameValue,
  sourceNames,
  studioPlacementRemovalReference,
} from "./composition-references";
import {
  type ImmutablePlatformBlockCatalogue,
  applicationSourceDocumentSchema,
  sourceItemTree,
  sourcePlacementLayoutSchema,
  sourceSlotBreakpointOrders,
  repeatableSlotItemIdentities,
  repeatableSlotKey,
  isRepeatableSlotIdentity,
  conditionalFormatRuleFields,
  recordsTableFeaturesOrLog,
  type ApplicationSourceDocument,
  type PlatformBlockRelease,
  type SourceBlockPropertyValueContract,
  type SourceItem,
} from "@vortex/platform/schema";
import {
  boardModeOf,
  boardMoveRecordTypeProblem,
  createStudioBoardQuery,
  ensureStudioBoardTotals,
  studioBoardQueryFits,
} from "./board-source";
import { applyStudioFlowCreate } from "./application-flow-create";
import { ensureStudioBoardQuickAdd } from "./board-quick-add";
import { studioLayoutOutletPlacementUses } from "./application-layout-outlets";
import { createStudioDiscoveryAdapter } from "./discovery-adapter";
import {
  studioOwnsSetting,
  studioQueryOffered,
  studioReleaseReadsQuery,
} from "./contextual-palette";
import {
  adjustedSlotOrder,
  StoredCompositionRefusal,
  validateStoredShell,
  validateStoredApplicationOutlets,
  validateStoredZone,
} from "./stored-composition";
import { restoreStudioGridFeatureBindings } from "./grid-features";
import type { StudioSemanticSelection } from "./semantic-selection";
import type {
  StudioCompositionBreakpoint,
  StudioCompositionContext,
  StudioCompositionCommand,
  StudioCompositionSettingsModel,
  StudioCompositionDestination,
  StudioCompositionDestinationModel,
  StudioCompositionCommandResult,
  StudioCompositionRemovalModel,
  StudioCompositionEditorModel,
} from "./application-composition-model";
import {
  type Zone,
  type Region,
  type SlotStep,
  type Target,
  refuse,
  regions,
  releaseFor,
  itemSlots,
  itemReading,
  pinnedRelease,
  manifestMatches,
  resolve,
  sameSteps,
  closedPlain,
  parseDestination,
  sameDestination,
  workingCopy,
  zoneHandle,
  workingItem,
  commitWorking,
  validateRegion,
  plainSource,
  plainSettings,
} from "./application-composition-regions";
import { applyAdd, commandSettings } from "./application-composition-add";
import { applyWrap } from "./application-composition-wrap";

export type * from "./application-composition-model";
export {
  studioPlacementRemovalReference,
  studioPlacementReferenceSentence,
  type StudioCompositionRemovalReason,
} from "./composition-references";
export { describeStudioCompositionAddTargets } from "./application-composition-add";
export { describeStudioCompositionWrap } from "./application-composition-wrap";

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

type MoveDestination = {
  destination: StudioCompositionDestination;
  label: string;
  steps: readonly SlotStep[];
};

/** A display page's content is its main area or the content slot its layout opens for it. */
const pageContentRegion = (
  region: Region,
): region is Region & { page: NonNullable<Region["page"]> } =>
  (region.ordinaryMain === true || region.parent !== undefined) &&
  (region.page?.type === "list" ||
    region.page?.type === "detail" ||
    region.page?.type === "dashboard");

/** The regions whose blocks move: a display page's content and a layout's own blocks. */
const movableRegion = (region: Region): boolean =>
  region.shell !== undefined || pageContentRegion(region);

/**
 * Only actual non-repeatable slots in this original movable region are destinations. A layout
 * slot that holds a page's content outlet is never one: it holds page content, not layout blocks.
 */
const moveDestinations = (
  catalogue: ImmutablePlatformBlockCatalogue,
  target: Target,
  alias: string,
): MoveDestination[] => {
  if (!movableRegion(target.region)) return [];
  const shell = target.region.shell;
  const outletSlots = new Set(
    shell?.content_slots.map((slot) => `${slot.parent_placement}|${slot.parent_slot}`) ?? [],
  );
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
          !outletSlots.has(`${parentAlias}|${declaration.key}`) &&
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
  if (target.steps.length > 0) {
    const topLevel =
      shell === undefined ||
      createStudioDiscoveryAdapter({ catalogue, surface: { kind: "authenticated" } })
        .getPlacementChoices({ kind: "shell_layout" })
        .some(
          (choice) =>
            choice.blockId === movedRelease.blockId &&
            choice.releaseVersion === movedRelease.releaseVersion,
        );
    if (topLevel)
      result.push({
        destination: { kind: "root" },
        label: shell === undefined ? "The main area of this page" : "The top of this layout",
        steps: [],
      });
  }
  visit(target.region.zone, []);
  return selectedPathSupported ? result : [];
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
 * Which placed blocks the settings edit reaches: any block of a layout, and any block on a page
 * that is not public and that no experience shows, in a content area whose blocks all name releases the source depends on.
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
    target.region.shell === undefined &&
    (page === undefined ||
      page.type === "public" ||
      source.body.public_addresses.some((address) => address.page === page.id) ||
      source.body.experiences?.some((experience) => experience.page === page.key))
  )
    return { kind: "unsupported" } as const;
  const release = releaseFor(catalogue, target.item);
  if (release === undefined || !manifestMatches(catalogue, source, target.region.zone.items))
    return { kind: "unsupported" } as const;
  validateRegion(catalogue, target.region);
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
  // Studio owns some settings: a settings edit keeps each exactly as stored.
  const stored = itemReading(current.catalogue, target.item).settings;
  for (const key of Object.keys(settings)) if (studioOwnsSetting(key)) delete settings[key];
  for (const [key, value] of Object.entries(stored))
    if (studioOwnsSetting(key)) settings[key] = value;
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
  const formatting = recordsTableFeaturesOrLog(
    settings["features"] as never,
    "studio board rules",
  )?.conditionalFormatting;
  const ruleFields =
    board !== undefined && formatting?.enabled
      ? [
          ...new Set(
            formatting.rules.filter((rule) => rule.enabled).flatMap(conditionalFormatRuleFields),
          ),
        ]
      : [];
  const moveProblem =
    board === undefined ? undefined : boardMoveRecordTypeProblem(source, alias, board);
  if (moveProblem !== undefined) return { kind: "refused", reason: moveProblem };
  if (
    board?.columnField !== undefined &&
    board.cardTitleField !== undefined &&
    (query === null || !studioBoardQueryFits(source, board, query, ruleFields))
  ) {
    const made = createStudioBoardQuery(source, board, sourceNames(source), query, ruleFields);
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
    validateStoredApplicationOutlets(current.catalogue, source);
  } catch (error) {
    if (error instanceof StoredCompositionRefusal) {
      console.error("[studio] composition settings refused", {
        part: error.location,
        reason: error.reason,
      });
      return {
        kind: "refused",
        reason: `${release.name} can't take these settings. ${error.message}.`,
      };
    }
    throw error;
  }
  // A board's card moves are saved through a flow: the first time the board is on, it gets the
  // one flow that saves the moved card's new stage, so its pipeline and the action owning the
  // stage apply. It stays when the board is switched off and is reused when it is switched on.
  let flowed: ApplicationSourceDocument = source;
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
    flowed = moved.source;
  }
  // Quick add opens the record type's create form from a column, through one flow like the move.
  if (board !== undefined) {
    const added = ensureStudioBoardQuickAdd(flowed, alias, board);
    if (added.kind === "refused") return added;
    flowed = added.source;
  }
  if (flowed !== source) return { kind: "applied", source: flowed };
  const parsed = applicationSourceDocumentSchema.parse(source);
  return sameValue(parsed, current.source)
    ? { kind: "invalid" }
    : { kind: "applied", source: parsed };
};

type Removal = {
  source: ApplicationSourceDocument;
  target: Target;
  alias: string;
  /** Releases no block uses once the block and everything inside it leave the draft. */
  unusedReleases: readonly string[];
};
const releaseKey = (block: { block_id: string; release_version: string }): string =>
  `${block.block_id}@${block.release_version}`;
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
  // Any of a layout's own blocks leaves with everything inside it, as any of them can be added.
  // A page removes one display item, and only from its content.
  const layout = target.region.shell !== undefined;
  if (!layout) {
    if (!pageContentRegion(target.region)) return { kind: "unsupported", reason: "page_kind" };
    const page = target.region.page;
    if (
      source.body.public_addresses.some((address) => address.page === page.id) ||
      source.body.experiences?.some((experience) => experience.page === page.key)
    )
      return { kind: "unsupported", reason: "public_page" };
  }
  if (
    releaseFor(catalogue, target.item) === undefined ||
    !manifestMatches(catalogue, source, target.region.zone.items) ||
    (target.region.parent !== undefined && !pinnedRelease(catalogue, source, target.region.parent))
  )
    return { kind: "unsupported", reason: "manifest_mismatch" };
  validateRegion(catalogue, target.region);
  if (studioLayoutOutletPlacementUses(source, alias).length > 0)
    return { kind: "blocked", reason: "content_outlet" };
  let zone = target.region.zone;
  for (const step of target.steps) {
    const parent = zone.items.find((item) => item.props.id === step.parentAlias);
    const declaration =
      parent === undefined
        ? undefined
        : releaseFor(catalogue, parent)?.slots.find((item) => item.key === step.slotKey);
    const child = parent === undefined ? undefined : itemSlots(catalogue, parent).get(step.slotKey);
    if (declaration === undefined || child === undefined)
      return { kind: "unsupported", reason: "manifest_mismatch" };
    if (declaration.repeats !== undefined) return { kind: "unsupported", reason: "repeating_slot" };
    if (child.items === target.zone.items && declaration.required && child.items.length === 1)
      return { kind: "blocked", reason: "required_slot" };
    zone = child;
  }
  const removed = sourceItemTree([target.item]);
  const aliases = new Set<string>();
  const releaseUses = new Map<string, number>();
  for (const region of regions(source))
    for (const item of sourceItemTree(region.zone.items)) {
      const id = item.props.id;
      if (aliases.has(id)) return { kind: "invalid" };
      aliases.add(id);
      const key = releaseKey(item.props.vortex.block);
      releaseUses.set(key, (releaseUses.get(key) ?? 0) + 1);
    }
  for (const item of removed) {
    const reference = studioPlacementRemovalReference(source, item.props.id, aliases);
    if (reference !== undefined) return { kind: "blocked", ...reference };
    const key = releaseKey(item.props.vortex.block);
    releaseUses.set(key, releaseUses.get(key)! - 1);
  }
  // What a flow still names is the cause to fix first, so it is told before the item's content is.
  if (
    !layout &&
    [...itemSlots(catalogue, target.item).values()].some((slot) => slot.items.length > 0)
  )
    return { kind: "unsupported", reason: "has_children" };
  return {
    kind: "available",
    removal: {
      source,
      target,
      alias,
      unusedReleases: [...releaseUses].filter(([, uses]) => uses === 0).map(([key]) => key),
    },
  };
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
          willRemoveUnusedRelease: resolved.removal.unusedReleases.length > 0,
        }
      : resolved;
  } catch (error) {
    console.error("[studio] removal model failed", error);
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
  const { source, target, alias, unusedReleases } = resolved.removal;
  const working = workingCopy(target.region);
  const zone = zoneHandle(working, target.steps);
  const remaining = zone.items.filter((item) => item.props.id !== alias);
  if (remaining.length !== zone.items.length - 1) return { kind: "invalid" };
  // The block and everything inside it leave the slot and its declared tablet and phone orders.
  zone.set(
    remaining,
    adjustedSlotOrder(
      zone.order,
      remaining.map((item) => item.props.id),
    ),
  );
  commitWorking(current.catalogue, target.region, working);
  validateStoredApplicationOutlets(current.catalogue, source);
  source.body.platform_block_dependencies = source.body.platform_block_dependencies.filter(
    (dependency) => !unusedReleases.includes(releaseKey(dependency)),
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
    if (!movableRegion(target.region)) return { kind: "unsupported", reason: "page_kind" };
    if (
      !manifestMatches(catalogue, source, target.region.zone.items) ||
      (target.region.parent !== undefined &&
        !pinnedRelease(catalogue, source, target.region.parent))
    )
      return { kind: "unsupported", reason: "manifest_mismatch" };
    validateRegion(catalogue, target.region);
    return {
      kind: "available",
      destinations: moveDestinations(catalogue, target, alias).map(({ destination, label }) => ({
        destination,
        label,
      })),
    };
  } catch (error) {
    console.error("[studio] move model failed", error);
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
    if (command.kind === "remove") {
      if (
        selection?.kind === "placement" &&
        studioLayoutOutletPlacementUses(current.source, selection.placementAlias).length > 0
      )
        return {
          kind: "refused",
          reason:
            "This block holds a content outlet of its layout. Retarget the outlet in the Layout inspector before removing the block.",
        };
      return applyRemoval(current, selection, command);
    }
    if (command.kind === "settings") return applySettings(current, selection, command);
    if (command.kind === "wrap") return applyWrap(current, selection, command);
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
      if (!movableRegion(target.region)) return { kind: "unsupported" };
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
      validateStoredApplicationOutlets(catalogue, source);
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
    validateStoredApplicationOutlets(catalogue, source);
    const parsed = applicationSourceDocumentSchema.parse(source);
    if (sameValue(parsed, current.source)) return { kind: "invalid" };
    return { kind: "applied", source: parsed };
  } catch (error) {
    console.error("[studio] composition command could not be applied", error);
    if (error instanceof StoredCompositionRefusal)
      return { kind: "refused", reason: error.message };
    return { kind: "invalid" };
  }
};
