import type { Data } from "@puckeditor/core";
import {
  applicationSourceDocumentSchema,
  definitionLimitMessage,
  definitionLimits,
  removeFlowBindingsOf,
  setSourcePageSlot,
  sourceItemTree,
  sourcePageSlotAt,
  StoredCompositionRefusal,
  storedZoneAliases,
  storedZoneFromPuck,
  syncStoredBlockDependencies,
  validateStoredApplicationOutlets,
  withCopiedFlowBindings,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type PageSlotAddress,
} from "@vortex/platform/schema";
import { regions } from "./application-composition-regions";
import { regionLevels } from "./studio-composition-depth";
import {
  studioFormChangeRefusal,
  studioFormChangeRefusalSentence,
} from "./application-composition-forms";
import {
  studioPlacementReferenceSentence,
  studioPlacementRemovalReference,
} from "./composition-references";
import { zoneJson } from "./studio-canvas-data";

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

/**
 * Every canvas change goes back through the definition: Puck's data is converted to the authored
 * content area, placed in the current draft and validated before the history takes it.
 */
export const applyStudioCanvasChange = (
  catalogue: ImmutablePlatformBlockCatalogue,
  current: ApplicationSourceDocument,
  pageAlias: string,
  at: PageSlotAddress,
  candidate: Data,
  rootProps: Readonly<Record<string, unknown>>,
): StudioCanvasChange => {
  try {
    const matches = current.body.pages.filter((item) => item.id === pageAlias);
    const target = matches[0];
    const targetSlot = target === undefined ? undefined : sourcePageSlotAt(target, at);
    if (matches.length !== 1 || targetSlot === undefined)
      throw new TypeError("The selected page is unavailable.");
    const { zone: editedSlot, copies } = storedZoneFromPuck(
      catalogue,
      targetSlot,
      candidate,
      rootProps,
    );
    // Puck reports the draft it was just given (after Undo, Redo or a save) as a change too.
    if (zoneJson(editedSlot) === zoneJson(targetSlot)) return { kind: "unchanged" };
    const next = structuredClone(current);
    const nextPage = next.body.pages.find((item) => item.id === pageAlias);
    if (nextPage === undefined || !setSourcePageSlot(nextPage, at, editedSlot))
      throw new TypeError("The selected page is unavailable.");
    const kept = storedZoneAliases(editedSlot);
    const removed = new Set([...storedZoneAliases(targetSlot)].filter((alias) => !kept.has(alias)));
    // Deleting and dragging keep every form whole, by the same rule as Remove and Move.
    const broken = studioFormChangeRefusal(catalogue, current, targetSlot.items, editedSlot.items);
    if (broken !== undefined)
      return {
        kind: "refused",
        message: `${studioFormChangeRefusalSentence(broken, studioPlacementReferenceSentence)} The page stays as it was.`,
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
        message: `${studioPlacementReferenceSentence(reference)} The item stays on the page.`,
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
    console.error("Failed to apply Puck page changes", error);
    return {
      kind: "refused",
      message:
        error instanceof StoredCompositionRefusal
          ? `This page change could not be applied. ${error.message}. The saved draft and current edits are preserved.`
          : "This page change could not be applied. The saved draft and current edits are preserved.",
    };
  }
};
