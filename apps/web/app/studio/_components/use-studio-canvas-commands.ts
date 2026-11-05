import type { ApplicationSourceDocument, ConditionNode } from "@vortex/platform/schema";
import type { StudioDraft, StudioDraftStep } from "./use-studio-draft";
import {
  applyDraftChange,
  applyStudioItemLabels,
  sameStudioCompositionContext,
  studioBlockChoices,
  studioSemanticSelectionKey,
  type StudioDraftChange,
  type StudioCompositionContext,
  type StudioCompositionOutcome,
  type StudioItemLabelResult,
  type StudioSemanticSelection,
  applyStudioReactionCondition,
  type StudioApplicationConditionContext,
  type StudioReactionCommandResult,
  type StudioReactionSlot,
  applyStudioPageValue,
  settingsChangeOfPuckEdit,
  type StudioPageValueCommand,
  type StudioPageValueResult,
  type StudioSettingsEdit,
} from "@vortex/platform/schema";

type DraftChangeOptions = Readonly<{
  /** Consecutive edits with this key (typing into one field) are one Undo step. */
  merge?: string | undefined;
  /** The reading the caller's view was drawn from; any other current one makes the change stale. */
  expected?: StudioCompositionContext | undefined;
  /** The draft a view of the canvas was drawn from; any other current one refuses the change. */
  expectedSource?: ApplicationSourceDocument | undefined;
}>;

/** The ways a person, the canvas and the agent change a page's composition, over one draft. */
export type StudioCanvasCommands = Readonly<{
  liveContext: () => StudioCompositionContext;
  runDraftChange: (
    selection: StudioSemanticSelection | null,
    change: StudioDraftChange,
    options?: DraftChangeOptions,
  ) => StudioCompositionOutcome;
  commandComposition: (
    expected: StudioCompositionContext,
    expectedSelection: StudioSemanticSelection,
    change: StudioDraftChange,
    merge?: string,
  ) => StudioCompositionOutcome;
  onSettingsEdit: (edit: StudioSettingsEdit, merge: string) => StudioCompositionOutcome;
  onCanvasChange: (
    selection: StudioSemanticSelection | null,
    change: StudioDraftChange,
    expectedSource: ApplicationSourceDocument,
  ) => StudioCompositionOutcome;
  runAdd: (change: Extract<StudioDraftChange, { kind: "add" }>) => string | true;
  commandPageValue: (command: StudioPageValueCommand) => StudioPageValueResult;
  commandReaction: (
    expected: StudioCompositionContext,
    expectedSelection: StudioSemanticSelection,
    metadata: StudioApplicationConditionContext | null,
    condition: ConditionNode | undefined,
    slot: StudioReactionSlot,
  ) => StudioReactionCommandResult;
  setLabels: (
    selection: StudioSemanticSelection,
    name: string,
    description: string,
    merge?: string,
  ) => StudioItemLabelResult | Readonly<{ kind: "blocked"; message: string }>;
}>;

/**
 * Every composition edit of the canvas tab goes through `runDraftChange`, the one place that runs
 * the composition core inside the draft's envelope: the item editor's controls, the Data tab's
 * placements, the agent tools, the canvas settings fields and the palette.
 */
export function useStudioCanvasCommands({
  draft,
  organizationId,
  key,
  blockChoices,
}: Readonly<{
  draft: StudioDraft;
  organizationId: string;
  key: string;
  blockChoices: Parameters<typeof studioBlockChoices>[0];
}>): StudioCanvasCommands {
  const liveContext = (): StudioCompositionContext => {
    const current = draft.history.getState();
    return {
      organizationId,
      rootId: current.rootId,
      key,
      draftRevision: current.draftRevision,
      localLifetime: draft.lifetime,
      catalogue: draft.readCatalogue(),
      source: current.source,
      borrowed: draft.view.borrowedChoices,
    };
  };

  const runDraftChange: StudioCanvasCommands["runDraftChange"] = (
    selection,
    change,
    options = {},
  ) => {
    const outcome = draft.run(
      (): StudioDraftStep<StudioCompositionOutcome> => {
        const context = liveContext();
        // Checked in the same step as the write, so both see the same draft.
        if (
          options.expected !== undefined &&
          !sameStudioCompositionContext(options.expected, context)
        )
          return { kind: "keep", result: { kind: "stale" } };
        const result = applyDraftChange(context, selection, change);
        if (result.kind === "applied")
          return {
            kind: "edit",
            source: result.source,
            result:
              result.placementAlias === undefined
                ? { kind: "applied" }
                : { kind: "applied", placementAlias: result.placementAlias },
          };
        return {
          kind: "keep",
          result:
            result.kind === "refused"
              ? { kind: "refused", reason: result.reason }
              : { kind: result.kind },
        };
      },
      { merge: options.merge, expected: options.expectedSource },
    );
    return outcome.kind === "done" ? outcome.result : { kind: "refused", reason: outcome.message };
  };

  // The inspector's controls, block dialogs, gate, Move to and Wrap, and the agent's tools.
  const commandComposition: StudioCanvasCommands["commandComposition"] = (
    expected,
    expectedSelection,
    change,
    merge,
  ) => {
    // The whole-page write comes from the canvas alone (`onCanvasChange`).
    if (change.kind === "pageData") return { kind: "invalid" };
    const now = draft.selection.getSelection();
    if (
      now === null ||
      studioSemanticSelectionKey(now) !== studioSemanticSelectionKey(expectedSelection)
    )
      return { kind: "stale" };
    return runDraftChange(now, change, { merge, expected });
  };

  // The canvas settings fields' edit: read from the draft as it is now, and written only if it
  // still is.
  const onSettingsEdit: StudioCanvasCommands["onSettingsEdit"] = (edit, merge) => {
    const context = liveContext();
    const change = settingsChangeOfPuckEdit(
      context,
      (query) => studioBlockChoices(blockChoices, query),
      edit,
    );
    if (change.kind !== "settings") return { kind: change.kind };
    return runDraftChange({ kind: "placement", placementAlias: edit.alias }, change, {
      merge,
      expected: context,
    });
  };

  // A change of the canvas (a drag, Duplicate, Delete): it edits the draft it was drawn from, so
  // any change in between makes it stale.
  const onCanvasChange: StudioCanvasCommands["onCanvasChange"] = (
    selection,
    change,
    expectedSource,
  ) => runDraftChange(selection, change, { expectedSource });

  // The one add path for a new block: a drop on the canvas, the palette's Add button and the
  // setup dialog.
  const runAdd: StudioCanvasCommands["runAdd"] = (change) => {
    const outcome = runDraftChange(draft.selection.getSelection(), change);
    if (outcome.kind === "applied") {
      if (outcome.placementAlias !== undefined)
        draft.select({ kind: "placement", placementAlias: outcome.placementAlias });
      return true;
    }
    if (outcome.kind === "refused" && outcome.reason !== undefined) return outcome.reason;
    console.error(`[studio] adding a block was refused: STUDIO_ADD_${outcome.kind.toUpperCase()}`);
    return "The block could not be added, so the draft is unchanged.";
  };

  // The page's declared values, added, changed and removed as one undoable edit each.
  const commandPageValue: StudioCanvasCommands["commandPageValue"] = (command) => {
    const outcome = draft.run((current): StudioDraftStep<StudioPageValueResult> => {
      const result = applyStudioPageValue(current, command);
      return result.kind === "applied"
        ? { kind: "edit", source: result.source, result }
        : { kind: "keep", result };
    });
    return outcome.kind === "blocked"
      ? { kind: "refused", reason: outcome.message }
      : outcome.result;
  };

  const commandReaction: StudioCanvasCommands["commandReaction"] = (
    expected,
    expectedSelection,
    metadata,
    condition,
    slot,
  ) => {
    const currentSelection = draft.selection.getSelection();
    if (
      currentSelection?.kind !== "placement" ||
      expectedSelection.kind !== "placement" ||
      currentSelection.placementAlias !== expectedSelection.placementAlias
    )
      return { kind: "stale" };
    const outcome = draft.run(
      (): StudioDraftStep<StudioReactionCommandResult> => {
        const result = applyStudioReactionCondition(
          expected,
          liveContext(),
          currentSelection,
          metadata,
          condition,
          slot,
        );
        return result.kind === "applied"
          ? { kind: "edit", source: result.source, result }
          : { kind: "keep", result };
      },
      { merge: `${slot}:${currentSelection.placementAlias}` },
    );
    return outcome.kind === "done" ? outcome.result : { kind: "stale" };
  };

  // An item's name and description: the inspector merges a run of typing into one Undo step; the
  // agent passes no `merge`, so its rename never joins the person's.
  const setLabels: StudioCanvasCommands["setLabels"] = (selection, name, description, merge) => {
    const outcome = draft.run<StudioItemLabelResult>(
      (current) => {
        const applied = applyStudioItemLabels(current, selection, name, description);
        return applied.kind === "applied"
          ? { kind: "edit", source: applied.source, result: applied }
          : { kind: "keep", result: applied };
      },
      { merge },
    );
    return outcome.kind === "blocked" ? outcome : outcome.result;
  };

  return {
    liveContext,
    runDraftChange,
    commandComposition,
    onSettingsEdit,
    onCanvasChange,
    runAdd,
    commandPageValue,
    commandReaction,
    setLabels,
  };
}
