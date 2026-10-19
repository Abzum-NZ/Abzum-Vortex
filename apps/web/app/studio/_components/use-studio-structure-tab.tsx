"use client";
import { useMemo, useState } from "react";
import type { ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import {
  studioSemanticSelectionKey,
  type StudioPlacementDescriber,
  type StudioSemanticOutline,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";
import {
  applyStudioStructureCommand,
  studioPageLayoutPlan,
  type StudioStructureCommand,
  type StudioStructureResult,
} from "@vortex/ui/studio";
import { studioFieldPublication } from "./module-fields-editor";
import { StudioStructurePanel } from "./studio-outline-panels";
import {
  StudioStructureEditor,
  StudioStructureAdd,
  type StudioStructureForm,
} from "./studio-structure-editor";
import type { StudioDraft } from "./use-studio-draft";

/**
 * The Structure tab: the application's layouts and pages as a tree, and the controls that add,
 * rename, move, remove or make home the selected one. Each control is one checked Structure
 * command through the draft's envelope.
 */
export function useStudioStructureTab({
  draft,
  catalogue,
  describePlacement,
  outline,
  hidden,
  openAccessPages,
}: Readonly<{
  draft: StudioDraft;
  catalogue: ImmutablePlatformBlockCatalogue;
  describePlacement: StudioPlacementDescriber;
  outline: StudioSemanticOutline;
  hidden: boolean;
  /** Opens Access on its Pages and menu view, where who can open a page is set. */
  openAccessPages: () => void;
}>) {
  const { source, selected } = draft;
  const [form, setForm] = useState<StudioStructureForm>("none");
  const publishedFields = useMemo(
    () => studioFieldPublication(draft.view.published, draft.parsed(draft.saved.source)).fields,
    [draft, draft.view.published, draft.saved.source],
  );
  const command = (
    structureCommand: StudioStructureCommand,
    merge?: string,
  ): StudioStructureResult => {
    const after: { select?: StudioSemanticSelection | undefined } = {};
    const outcome = draft.run<StudioStructureResult>(
      (current) => {
        const result = applyStudioStructureCommand(
          { source: current, catalogue, describePlacement, publishedFields },
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
    applyStudioStructureCommand(
      {
        source: draft.parsed(draft.history.getState().source),
        catalogue,
        describePlacement,
        publishedFields,
      },
      structureCommand,
    );
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
      action={<StudioStructureAdd disabled={draft.locked} onAdd={setForm} />}
      editor={
        <StudioStructureEditor
          form={form}
          onFormChange={setForm}
          source={source}
          selected={selected}
          onCommand={command}
          onPreview={preview}
          onLayoutPlan={(pageAlias, shellAlias) =>
            studioPageLayoutPlan(
              { source, catalogue, describePlacement, publishedFields },
              pageAlias,
              shellAlias,
            )
          }
          onOpenAccess={openAccessPages}
          disabled={draft.locked}
        />
      }
    />
  );
  return { panel };
}
