"use client";
import { useEffect, useState, type ReactNode } from "react";
import { describeFailure } from "@vortex/platform/schema";
import { reopenModuleFieldLabel } from "../module-field-label-actions";
import { reopenModuleFields } from "../modules/[organizationId]/[moduleRootId]/fields/actions";
import { loadModuleQueryFilter } from "../modules/[organizationId]/[moduleRootId]/queries/actions";
import { loadModuleBeforeSaveCondition } from "../modules/[organizationId]/[moduleRootId]/before-save/actions";
import {
  loadStudioModulePublicationDraft, prepareStudioModulePublication, publishStudioModule,
} from "../modules/[organizationId]/[moduleRootId]/publish/actions";
import { ModuleFieldsWorkspace } from "./module-fields-workspace";
import { ModuleFieldLabelEditor } from "./module-field-label-editor";
import { ModuleQueryFilterEditor } from "./module-query-filter-editor";
import { ModuleBeforeSaveConditionEditor } from "./module-before-save-condition-editor";
import { ModulePublicationEditor } from "./module-publication-editor";
import { StudioUnavailable } from "./studio-unavailable";
import { ModuleEditorDirtyProvider } from "./module-editor-dirty";
import type { StudioModuleTarget } from "../_lib/studio-module-tools";

type Loaded = Readonly<{ kind: "loading" }> | Readonly<{ kind: "ready"; editor: ReactNode }>;

/** Reads the chosen module tool's draft through its server actions (the one read path) and draws that editor. */
const loadEditor = async ({ organizationId, moduleRootId, tool }: StudioModuleTarget): Promise<ReactNode> => {
  const key = `${organizationId}:${moduleRootId}`;
  switch (tool) {
    case "fields": {
      const result = await reopenModuleFields(organizationId, moduleRootId);
      return result.kind === "available"
        ? <ModuleFieldsWorkspace key={key} draft={result.draft} />
        : <StudioUnavailable subject="Module fields" result={result} />;
    }
    case "labels": {
      const result = await reopenModuleFieldLabel(organizationId, moduleRootId);
      return result.kind === "available"
        ? <ModuleFieldLabelEditor key={key} draft={result.draft} fields={result.fields} />
        : <StudioUnavailable subject="Module draft" result={result} />;
    }
    case "queries":
      return <ModuleQueryFilterEditor key={key} organizationId={organizationId} moduleRootId={moduleRootId}
        initial={await loadModuleQueryFilter(organizationId, moduleRootId)} />;
    case "before-save":
      return <ModuleBeforeSaveConditionEditor key={key} organizationId={organizationId} moduleRootId={moduleRootId}
        initial={await loadModuleBeforeSaveCondition(organizationId, moduleRootId)} />;
    case "publish": {
      const result = await loadStudioModulePublicationDraft(organizationId, moduleRootId);
      if (result.kind !== "available") return <StudioUnavailable subject="Module publication" result={result} />;
      if (result.draft.kind !== "module")
        return <StudioUnavailable subject="Module publication" result={{ kind: "refused", reason: "draft_kind_mismatch" }} />;
      return <ModulePublicationEditor key={key} draft={result.draft}
        prepare={prepareStudioModulePublication} publish={publishStudioModule} />;
    }
  }
};

/**
 * A module editor embedded in the Data tab's centre; it is read again whenever the target changes.
 * `onDirtyChange` reports whether the editor holds unsaved input, so the workspace asks before replacing it.
 */
export function StudioModuleEditor({ target, onDirtyChange }: Readonly<{
  target: StudioModuleTarget; onDirtyChange: (dirty: boolean) => void;
}>) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    setLoaded({ kind: "loading" });
    loadEditor(target).then((editor) => { if (current) setLoaded({ kind: "ready", editor }); }, (error: unknown) => {
      console.error(`[studio] module ${target.tool} editor failed to load`, describeFailure(error));
      if (current) setLoaded({ kind: "ready", editor:
        <StudioUnavailable subject="Module draft" result={{ kind: "temporarily_unavailable" }} /> });
    });
    return () => { current = false; };
  }, [target.organizationId, target.moduleRootId, target.tool]);
  return <ModuleEditorDirtyProvider onChange={onDirtyChange}>
    {loaded.kind === "loading" ? <p role="status" className="p-6">Opening the module…</p> : loaded.editor}
  </ModuleEditorDirtyProvider>;
}
