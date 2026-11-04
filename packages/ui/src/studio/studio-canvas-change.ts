import type { Data } from "@puckeditor/core";
import {
  applicationSourceDocumentSchema,
  describeApplicationUsers,
  definitionLimitMessage,
  definitionLimits,
  removeFlowBindingsOf,
  setSourcePageData,
  sourceItemTree,
  sourcePageDataAt,
  sourcePageZones,
  StoredCompositionRefusal,
  storedPageDataFromPuck,
  storedShellReservations,
  storedZoneAliases,
  syncStoredBlockDependencies,
  validateStoredApplicationOutlets,
  withCopiedFlowBindings,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceZonedData,
} from "@vortex/platform/schema";
import {
  PUBLISHED_PAGE_ADD_REASON,
  publishedPage,
  regions,
} from "./application-composition-regions";
import { regionLevels } from "./studio-composition-depth";
import {
  studioFormChangeRefusal,
  studioFormChangeRefusalSentence,
} from "./application-composition-forms";
import {
  studioPlacementReferenceSentence,
  studioPlacementRemovalReference,
} from "./composition-references";
import { pageDataJson } from "./studio-canvas-data";
import {
  studioDuplicateRefusal,
  studioOutletHostRefusal,
  studioPlacementReferrers,
  studioRemovalRuleRefusal,
} from "./studio-canvas-permissions";

/** What a change Puck reported on the canvas comes to in the definition. */
export type StudioCanvasChange =
  /** The data Puck reports is the draft it was given (after Undo, Redo or a save). */
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  /** The change breaks a rule of the definition; `message` says which, and the draft stays as it was. */
  | Readonly<{ kind: "refused"; message: string }>;

/** The plain sentence for a change that takes the application past a composition limit. */
const compositionLimitRefusal = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
): string | undefined => {
  const each = regions(source);
  const placed = each.reduce(
    (total, region) => total + sourceItemTree(region.zone.items).length,
    0,
  );
  if (placed > definitionLimits.compositionPlacements)
    return definitionLimitMessage("compositionPlacements");
  // A page nests inside the container of its layout, so the platform counts those levels too.
  if (
    each.some(
      (region) => regionLevels(catalogue, source, region) > definitionLimits.compositionDepth,
    )
  )
    return definitionLimitMessage("compositionDepth");
  return undefined;
};

/** What a canvas change edits: a page (or one step of a guided page), or a layout. */
export type StudioCanvasOwner =
  | Readonly<{ kind: "page"; pageAlias: string; step: string | undefined }>
  | Readonly<{ kind: "layout"; shellAlias: string }>;

/** The page or layout was removed or replaced while an edit was in flight: a race, refused like any other change. */
const unavailable = (owner: StudioCanvasOwner) =>
  new StoredCompositionRefusal(
    [],
    `its ${owner.kind} was removed while this change was being made`,
  );

/** The blocks of every zone of a page's (or layout's) data, in zone order. */
const dataItems = (data: SourceZonedData) => sourcePageZones(data).flatMap(([, items]) => items);

/** Every block name in the page data, at any depth. */
const dataAliases = (data: SourceZonedData): Set<string> =>
  storedZoneAliases({ items: dataItems(data), order: undefined });

/**
 * Every canvas change goes back through the definition, as the whole data of what the canvas
 * shows: Puck's data is converted to the authored page (or guided step) data, or to the layout,
 * placed in the current draft and validated before the history takes it.
 */
export const applyPageDataChange = (
  catalogue: ImmutablePlatformBlockCatalogue,
  current: ApplicationSourceDocument,
  owner: StudioCanvasOwner,
  candidate: Data,
): StudioCanvasChange => {
  try {
    const pages = current.body.pages.filter(
      (item) => owner.kind === "page" && item.id === owner.pageAlias,
    );
    const shells = current.body.shells.filter(
      (item) => owner.kind === "layout" && item.id === owner.shellAlias,
    );
    const target = pages[0];
    const targetShell = shells[0];
    const targetData: SourceZonedData | undefined =
      owner.kind === "layout"
        ? targetShell?.layout
        : target === undefined
          ? undefined
          : sourcePageDataAt(target, owner.step);
    if (pages.length + shells.length !== 1 || targetData === undefined) throw unavailable(owner);
    const { data: edited, copies } = storedPageDataFromPuck(
      catalogue,
      targetData,
      candidate,
      // A layout keeps its content slots empty: they hold the blocks of its pages.
      targetShell === undefined ? undefined : storedShellReservations(targetShell),
    );
    const subject = owner.kind;
    // Puck reports the draft it was just given (after Undo, Redo or a save) as a change too.
    if (pageDataJson(edited) === pageDataJson(targetData)) return { kind: "unchanged" };
    // Duplicate has the same refusals as its button, whichever draft the button was drawn from.
    const originals = sourceItemTree(dataItems(targetData));
    for (const original of copies.keys()) {
      const item = originals.find((entry) => entry.props.id === original);
      const refusal = item === undefined ? undefined : studioDuplicateRefusal(catalogue, item);
      if (refusal !== undefined)
        return { kind: "refused", message: `${refusal} The ${subject} stays as it was.` };
    }
    // A page published outside the application takes no new block: not a copy, not a drop.
    const before = dataAliases(targetData);
    const kept = dataAliases(edited);
    if (
      target !== undefined &&
      publishedPage(current, target) &&
      [...kept].some((alias) => !before.has(alias))
    )
      return { kind: "refused", message: PUBLISHED_PAGE_ADD_REASON };
    const next = structuredClone(current);
    if (owner.kind === "layout") {
      const nextShell = next.body.shells.find((item) => item.id === owner.shellAlias);
      if (nextShell === undefined) throw unavailable(owner);
      nextShell.layout = edited as typeof nextShell.layout;
    } else {
      const nextPage = next.body.pages.find((item) => item.id === owner.pageAlias);
      if (nextPage === undefined || !setSourcePageData(nextPage, owner.step, edited as never))
        throw unavailable(owner);
    }
    const removed = new Set([...before].filter((alias) => !kept.has(alias)));
    // Where a block may not leave from, whichever draft the canvas's reasons were read from.
    const rule =
      removed.size === 0 ? undefined : studioRemovalRuleRefusal(catalogue, current, removed);
    if (rule !== undefined) return { kind: "refused", message: rule };
    // A layout block that holds a content outlet stays until the outlet is retargeted.
    for (const alias of removed) {
      const host = studioOutletHostRefusal(current, alias);
      if (host !== undefined) return { kind: "refused", message: host };
    }
    for (const alias of removed) {
      const users = studioPlacementReferrers(current, alias, removed);
      if (users.length > 0)
        return {
          kind: "refused",
          message: `This block is used by ${describeApplicationUsers(users)}. Change that reference first.`,
        };
    }
    // Deleting and dragging keep every form whole, by the same rule as Remove and Move.
    const broken = studioFormChangeRefusal(
      catalogue,
      current,
      dataItems(targetData),
      dataItems(edited),
    );
    if (broken !== undefined)
      return {
        kind: "refused",
        message: `${studioFormChangeRefusalSentence(broken, studioPlacementReferenceSentence)} The ${subject} stays as it was.`,
      };
    next.body.flow_bindings = withCopiedFlowBindings(next.body.flow_bindings, copies);
    removeFlowBindingsOf(next.body, removed);
    // A flow step that still names a removed block (the form it shows) keeps it on the page.
    const aliases = new Set(
      regions(current).flatMap((region) =>
        sourceItemTree(region.zone.items).map((item) => item.props.id),
      ),
    );
    for (const alias of removed) {
      const reference = studioPlacementRemovalReference(next, alias, aliases);
      if (reference === undefined) continue;
      return {
        kind: "refused",
        message: `${studioPlacementReferenceSentence(reference)} The item stays on the ${subject}.`,
      };
    }
    syncStoredBlockDependencies(next);
    const parsed = applicationSourceDocumentSchema.safeParse(next);
    if (!parsed.success) throw parsed.error;
    validateStoredApplicationOutlets(catalogue, parsed.data);
    // Duplicate, paste and every other insert go through the limits the platform validator holds
    // the whole application to, so the person sees the plain sentence now, not a refused save.
    const overLimit = compositionLimitRefusal(catalogue, parsed.data);
    if (overLimit !== undefined) return { kind: "refused", message: overLimit };
    return { kind: "applied", source: parsed.data };
  } catch (error: unknown) {
    // A change the composition rules refuse (or a page removed under it) is an expected refusal,
    // already shown to the person as a sentence; anything else is a platform fault.
    if (error instanceof StoredCompositionRefusal)
      console.info("[studio] canvas change refused", error.message);
    else console.error("[studio] canvas change failed", error);
    return {
      kind: "refused",
      message:
        error instanceof StoredCompositionRefusal
          ? `This change could not be applied. ${error.message}. The saved draft and current edits are preserved.`
          : "This change could not be applied. The saved draft and current edits are preserved.",
    };
  }
};
