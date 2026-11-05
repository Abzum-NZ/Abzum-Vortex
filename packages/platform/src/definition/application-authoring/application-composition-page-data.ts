import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "../application-source-contracts";
import { definitionLimitMessage, definitionLimits } from "../definition-limits";
import {
  removeFlowBindingsOf,
  StoredCompositionRefusal,
  storedZoneAliases,
  syncStoredBlockDependencies,
  validateStoredApplicationOutlets,
  withCopiedFlowBindings,
} from "./stored-composition";
import { setSourcePageData, sourcePageDataAt } from "../application-page-slots";
import {
  sourceItemTree,
  sourcePageZones,
  type SourceZonedData,
} from "../application-composition/source-composition";
import type { ImmutablePlatformBlockCatalogue } from "../application-composition/platform-block-release";
import {
  studioFormChangeRefusal,
  studioFormChangeRefusalSentence,
} from "./application-composition-forms";
import type {
  StudioCanvasOwner,
  StudioDraftChange,
  StudioDraftChangeResult,
  StudioCompositionContext,
} from "./application-composition-model";
import {
  PUBLISHED_PAGE_ADD_REASON,
  publishedPage,
  regions,
} from "./application-composition-regions";
import { studioPlacementReferenceSentence, sameCompositionValue } from "./composition-references";
import { regionLevels } from "./studio-composition-depth";
import { studioDuplicateRefusal, studioRemovalRefusal } from "./studio-canvas-permissions";

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

/** The page or layout was removed or replaced while an edit was in flight: a race, refused like any other change. */
const unavailable = (owner: StudioCanvasOwner) =>
  new StoredCompositionRefusal(
    [],
    `its ${owner.kind} was removed while this change was being made`,
  );

/** The data a canvas change edits, with the page or layout that holds it. */
export const canvasOwnerData = (
  source: ApplicationSourceDocument,
  owner: StudioCanvasOwner,
): Readonly<{
  data: SourceZonedData;
  page: ApplicationSourceDocument["body"]["pages"][number] | undefined;
  shell: ApplicationSourceDocument["body"]["shells"][number] | undefined;
}> => {
  const page =
    owner.kind === "page"
      ? source.body.pages.find((item) => item.id === owner.pageAlias)
      : undefined;
  const shell =
    owner.kind === "layout"
      ? source.body.shells.find((item) => item.id === owner.shellAlias)
      : undefined;
  const data =
    owner.kind === "layout"
      ? shell?.layout
      : page === undefined
        ? undefined
        : sourcePageDataAt(page, owner.step);
  if (data === undefined) throw unavailable(owner);
  return { data, page, shell };
};

/** The blocks of every zone of a page's (or layout's) data, in zone order. */
const dataItems = (data: SourceZonedData) => sourcePageZones(data).flatMap(([, items]) => items);

/** Every block name in the page data, at any depth. */
const dataAliases = (data: SourceZonedData): Set<string> =>
  storedZoneAliases({ items: dataItems(data), order: undefined });

/** The block names that are in the current data and not in the edited data. */
const removedAliases = (current: SourceZonedData, edited: SourceZonedData): Set<string> => {
  const kept = dataAliases(edited);
  return new Set([...dataAliases(current)].filter((alias) => !kept.has(alias)));
};

/**
 * Why a whole page's (or layout's) data may not replace the current data, or undefined: Duplicate
 * has the refusals of its button, a page published outside the application takes no new block,
 * a block leaves only where every removal route lets it, and every form stays whole. The one set
 * of refusals for the canvas's whole-page write and for the draft agent's page replacement.
 */
export const studioPageDataRefusal = (
  context: StudioCompositionContext,
  owner: StudioCanvasOwner,
  edited: SourceZonedData,
  copyPairs: readonly (readonly [original: string, copy: string])[] = [],
): string | undefined => {
  const { catalogue, source: current } = context;
  const copies = new Map(copyPairs);
  const { data: targetData, page: target } = canvasOwnerData(current, owner);
  // Duplicate has the same refusals as its button, whichever draft the button was drawn from.
  const originals = sourceItemTree(dataItems(targetData));
  for (const original of copies.keys()) {
    const item = originals.find((entry) => entry.props.id === original);
    const refusal = item === undefined ? undefined : studioDuplicateRefusal(catalogue, item);
    if (refusal !== undefined) return refusal;
  }
  // A page published outside the application takes no new block: not a copy, not a drop.
  const before = dataAliases(targetData);
  if (
    target !== undefined &&
    publishedPage(current, target) &&
    [...dataAliases(edited)].some((alias) => !before.has(alias))
  )
    return PUBLISHED_PAGE_ADD_REASON;
  // Where a block may not leave from, whichever draft the canvas's reasons were read from: the
  // one refusal every removal route shares.
  const removed = removedAliases(targetData, edited);
  const gone = removed.size === 0 ? undefined : studioRemovalRefusal(catalogue, current, removed);
  if (gone !== undefined) return gone;
  // Dragging keeps every form whole, by the same rule as Move.
  const broken = studioFormChangeRefusal(
    catalogue,
    current,
    dataItems(targetData),
    dataItems(edited),
  );
  return broken === undefined
    ? undefined
    : studioFormChangeRefusalSentence(broken, studioPlacementReferenceSentence);
};

/**
 * The one whole-page write: the data of what the canvas shows (a page, a guided step or a layout)
 * placed in the current draft. The canvas's Duplicate and a drag across slots come here; they have
 * the refusals of their buttons and of Remove and Move, then the same validation as any other
 * command, so the person sees the plain sentence now, not a refused save.
 */
export const applyPageData = (
  context: StudioCompositionContext,
  change: Extract<StudioDraftChange, { kind: "pageData" }>,
): StudioDraftChangeResult => {
  const { catalogue, source: current } = context;
  const { owner, data: edited } = change;
  const refusal = studioPageDataRefusal(context, owner, edited, change.copies);
  if (refusal !== undefined) return { kind: "refused", reason: refusal };
  const copies = new Map(change.copies);
  const removed = removedAliases(canvasOwnerData(current, owner).data, edited);
  const next = structuredClone(current) as ApplicationSourceDocument;
  if (owner.kind === "layout") {
    const nextShell = next.body.shells.find((item) => item.id === owner.shellAlias);
    if (nextShell === undefined) throw unavailable(owner);
    nextShell.layout = edited as typeof nextShell.layout;
  } else {
    const nextPage = next.body.pages.find((item) => item.id === owner.pageAlias);
    if (nextPage === undefined || !setSourcePageData(nextPage, owner.step, edited as never))
      throw unavailable(owner);
  }
  next.body.flow_bindings = withCopiedFlowBindings(next.body.flow_bindings, copies);
  removeFlowBindingsOf(next.body, removed);
  syncStoredBlockDependencies(next);
  const parsed = applicationSourceDocumentSchema.parse(next);
  validateStoredApplicationOutlets(catalogue, parsed);
  const overLimit = compositionLimitRefusal(catalogue, parsed);
  if (overLimit !== undefined) return { kind: "refused", reason: overLimit };
  return sameCompositionValue(parsed, current)
    ? { kind: "invalid" }
    : { kind: "applied", source: parsed };
};
