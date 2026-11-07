"use client";
import { useMemo } from "react";
import type { ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import { studioFieldPublication } from "./module-fields-editor";
import { StudioStructurePanel } from "./studio-outline-panels";
import {
  StudioStructureEditor,
  StudioStructureAdd,
  type StudioStructureForm,
} from "./studio-structure-editor";
import type { StudioDraft } from "./use-studio-draft";
import {
  studioSemanticSelectionKey,
  type StudioPlacementDescriber,
  type StudioSemanticOutline,
  type StudioSemanticSelection,
  type StudioStructureResult,
  applyStudioStructureCommand,
  type StudioStructureCommand,
} from "@vortex/platform/schema";

/**
 * The one Structure command runner: a checked Structure command through the draft's envelope, and
 * what one would do to the current draft for its preview. The Structure tab and the Layout
 * inspector both edit through it.
 */
export function useStudioStructureCommand({
  draft,
  catalogue,
  describePlacement,
}: Readonly<{
  draft: StudioDraft;
  catalogue: ImmutablePlatformBlockCatalogue;
  describePlacement: StudioPlacementDescriber;
}>) {
  const publishedFields = useMemo(
    () => new Set(studioFieldPublication(draft.view.published).fields.keys()),
    [draft.view.published],
  );
  const command = (
    structureCommand: StudioStructureCommand,
    merge?: string,
  ): StudioStructureResult => {
    if (structureCommand.kind === "add_record_page" && draft.view.published === null)
      return {
        kind: "refused",
        message: "Publication details are loading. Try again in a moment.",
      };
    const after: { select?: StudioSemanticSelection | undefined } = {};
    const outcome = draft.run<StudioStructureResult>(
      (current) => {
        const result = applyStudioStructureCommand(
          {
            source: current,
            catalogue,
            describePlacement,
            publishedFields,
            rootId: draft.state.rootId,
          },
          structureCommand,
        );
        if (result.kind !== "applied") return { kind: "keep", result };
        after.select = result.select ?? {
          kind: "application",
          applicationRootId: draft.state.rootId,
        };
        return { kind: "edit", source: result.source, result };
      },
      { merge },
    );
    if (outcome.kind === "blocked") return { kind: "refused", message: outcome.message };
    if (after.select !== undefined) draft.select(after.select);
    return outcome.result;
  };
  // What a Structure command would do to the current draft, for its preview; nothing is kept.
  const preview = (structureCommand: StudioStructureCommand): StudioStructureResult =>
    structureCommand.kind === "add_record_page" && draft.view.published === null
      ? { kind: "refused", message: "Publication details are loading. Try again in a moment." }
      : applyStudioStructureCommand(
          {
            source: draft.parsed(draft.history.getState().source),
            catalogue,
            describePlacement,
            publishedFields,
            rootId: draft.state.rootId,
          },
          structureCommand,
        );
  return { command, preview, publishedFields };
}

export type StudioStructureCommandRunner = ReturnType<typeof useStudioStructureCommand>;

/**
 * The Structure tab: the application's layouts and pages as a tree, and the controls that add,
 * rename, move, remove or make home the selected one. Each control is one checked Structure
 * command through the draft's envelope.
 */
export function useStudioStructureTab({
  draft,
  structure,
  outline,
  hidden,
  form,
  onFormChange,
}: Readonly<{
  draft: StudioDraft;
  structure: StudioStructureCommandRunner;
  outline: StudioSemanticOutline;
  hidden: boolean;
  form: StudioStructureForm;
  onFormChange: (form: StudioStructureForm) => void;
}>) {
  const { source, selected } = draft;
  const { command, preview } = structure;
  const homePage = source.body.pages.find((page) => page.key === source.body.home_page);
  const selectionKey = selected === null ? "" : studioSemanticSelectionKey(selected);

  const panel = (
    <StudioStructurePanel
      outline={outline}
      selectedKey={selectionKey}
      disabled={draft.isHeld("publication")}
      choose={(node) => {
        if (node.selection !== null) draft.select(node.selection);
      }}
      hidden={hidden}
      homePageKey={
        homePage === undefined
          ? undefined
          : studioSemanticSelectionKey({ kind: "page", pageAlias: homePage.id })
      }
      action={<StudioStructureAdd disabled={draft.locked} onAdd={onFormChange} />}
      editor={
        <StudioStructureEditor
          form={form}
          onFormChange={onFormChange}
          source={source}
          onCommand={command}
          onPreview={preview}
          disabled={draft.locked || (form === "record" && draft.view.published === null)}
        />
      }
    />
  );
  return { panel };
}
