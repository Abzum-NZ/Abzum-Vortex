"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { applicationSourceDocumentV2Schema } from "@vortex/contracts";
import {
  applyStudioCompositionCommand,
  applyStudioFlowTextCommand,
  applyStudioFlowPresentationCommand,
  applyStudioFlowPresentationMoveCommand,
  createStudioApplicationDraftHistoryController,
  createStudioSemanticSelectionStore,
  projectStudioSemanticOutline,
  projectStudioFlowPresentationMoves,
  resolveStudioSelectionInspectorContext,
  studioSemanticSelectionKey,
  type StudioSemanticOutlineNode,
  type StudioStoredApplicationDraft,
  type StudioCompositionContext,
  type StudioFlowTextContext,
} from "@vortex/studio";
import { createStudioApplication, reopenStudioApplication, saveStudioApplication } from "../actions";
import { minimumApplicationSource, type MinimumApplicationInputs } from "../_lib/minimum-application-source";
import { ApplicationAppearanceEditor } from "./application-appearance-editor";
import { ApplicationCompositionEditor } from "./application-composition-editor";
import { ApplicationFlowEditor } from "./application-flow-editor";
import { ApplicationDraftPreview, type SavedHomepagePreviewContext } from "./application-draft-preview";

type WorkspaceProps =
  | Readonly<{ mode: "new"; organizationId: string }>
  | Readonly<{ mode: "existing"; organizationId: string; draft: StudioStoredApplicationDraft }>;

const inputClass = "w-full rounded border border-border bg-background px-3 py-2 text-foreground";
const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";

class StudioSaveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StudioSaveError";
  }
}

export function ApplicationDraftWorkspace(props: WorkspaceProps) {
  return props.mode === "new"
    ? <NewApplicationWorkspace organizationId={props.organizationId} />
    : <ExistingApplicationWorkspace organizationId={props.organizationId} draft={props.draft} />;
}

function NewApplicationWorkspace({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [inputs, setInputs] = useState<MinimumApplicationInputs>({
    key: "", name: "", description: "", moduleKey: "", moduleVersionSelection: "exact",
    moduleVersion: "", roleKey: "", roleName: "", homeName: "",
  });
  const [isCreating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(false);
  const lifetime = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    return () => { active.current = false; lifetime.current += 1; };
  }, []);

  const textInput = (key: Exclude<keyof MinimumApplicationInputs, "moduleVersionSelection">,
    label: string, maxLength: number, hint?: string) => <label className="block space-y-1">
      <span>{label}</span>
      <input className={inputClass} required maxLength={maxLength} value={inputs[key]}
        disabled={isCreating} onChange={(event) => setInputs({ ...inputs, [key]: event.target.value })} />
      {hint && <span className="block text-sm text-muted-foreground">{hint}</span>}
    </label>;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    const candidate = minimumApplicationSource(inputs);
    if (candidate.kind !== "valid") { setMessage(candidate.message); return; }
    pending.current = true;
    const requestLifetime = lifetime.current;
    setCreating(true);
    setMessage("Creating the draft…");
    try {
      const result = await createStudioApplication(organizationId, candidate.source);
      if (!active.current || requestLifetime !== lifetime.current) return;
      if (result.kind === "available") {
        // Navigate only to the writer's committed identity; the route then reads it afresh.
        router.replace(`/studio/${encodeURIComponent(result.draft.organizationId)}/${encodeURIComponent(result.draft.rootId)}`);
        setMessage("Draft created. Opening the saved workspace…");
      } else {
        setMessage(result.kind === "conflict"
          ? "This application key already exists or the draft changed. No draft was created."
          : result.kind === "refused"
            ? "The source or current draft permission was refused. No draft was created."
            : "Creation could not be verified. Your inputs are preserved; try again.");
      }
    } catch {
      if (active.current && requestLifetime === lifetime.current)
        setMessage("Creation could not be verified. Your inputs are preserved; try again.");
    } finally {
      pending.current = false;
      if (active.current && requestLifetime === lifetime.current) setCreating(false);
    }
  };

  return <main className="mx-auto max-w-3xl space-y-6 p-6">
    <header><h1 className="text-2xl font-semibold">Create an Application draft</h1>
      <p className="break-all text-sm">Organization: {organizationId}</p>
      <p>This creates an unpublished draft with one empty home page. It does not publish or install anything.</p></header>
    <form onSubmit={create} className="grid gap-4" aria-busy={isCreating}>
      {textInput("key", "Application key", 120, "Use lowercase namespaced segments, for example team.workspace. The derived .home.view permission must also fit the 120-character key limit.")}
      {textInput("name", "Application name", 120)}
      <label className="block space-y-1"><span>Description</span>
        <textarea className={inputClass} required maxLength={1000} value={inputs.description}
          disabled={isCreating} onChange={(event) => setInputs({ ...inputs, description: event.target.value })} /></label>
      <fieldset className="space-y-4 rounded border border-border p-4"><legend>Authored Module dependency</legend>
        {textInput("moduleKey", "Module key", 120)}
        <label className="block space-y-1"><span>Version requirement</span>
          <select className={inputClass} value={inputs.moduleVersionSelection} disabled={isCreating}
            onChange={(event) => setInputs({ ...inputs, moduleVersionSelection:
              event.target.value === "allowed_range" ? "allowed_range" : "exact" })}>
            <option value="exact">Exact version</option><option value="allowed_range">Allowed version range</option>
          </select></label>
        {textInput("moduleVersion", "Module version or range", 120)}
        <p className="text-sm">This records a dependency requirement. It does not establish that a release is published or installed.</p>
      </fieldset>
      {textInput("roleKey", "Contained role key", 40, "Use lowercase letters, digits and underscores.")}
      {textInput("roleName", "Contained role name", 60)}
      {textInput("homeName", "Home page name", 60)}
      <p className="text-sm">The contained role names only the draft's non-administrative home-view permission. Live role assignment remains separate.</p>
      <button className={buttonClass} type="submit" disabled={isCreating}>Create draft</button>
      <p role="status" aria-live="polite">{message}</p>
    </form>
  </main>;
}

function Outline({ node, selectedKey, choose }: {
  node: StudioSemanticOutlineNode;
  selectedKey: string;
  choose: (node: StudioSemanticOutlineNode) => void;
}) {
  return <li className="space-y-1">
    {node.selection === null ? <span className="text-sm text-muted-foreground">{node.label}</span>
      : <button type="button" className={`${buttonClass} w-full text-left`}
        aria-pressed={selectedKey === studioSemanticSelectionKey(node.selection)} onClick={() => choose(node)}>
        {node.label} <span className="text-xs text-muted-foreground">({node.kind})</span>
      </button>}
    {node.children.length > 0 && <ul className="space-y-1 border-l border-border pl-3">
      {node.children.map((child) => <Outline key={child.key} node={child} selectedKey={selectedKey} choose={choose} />)}
    </ul>}
  </li>;
}

function ExistingApplicationWorkspace({ organizationId, draft }: {
  organizationId: string; draft: StudioStoredApplicationDraft;
}) {
  const active = useRef(false);
  const lifetime = useRef(0);
  const reopening = useRef(false);
  const previewGeneration = useRef(0);
  const savedPreviewDraft = useRef(draft);
  const provisionalSaveDraft = useRef<StudioStoredApplicationDraft | null>(null);
  const readProvisionalSaveDraft = (): StudioStoredApplicationDraft | null => provisionalSaveDraft.current;
  const labelsPending = useRef(false);
  const [workspaceLifetime, setWorkspaceLifetime] = useState(0);
  const [history] = useState(() => createStudioApplicationDraftHistoryController(draft, {
    saveDraft: async (command) => {
      const requestLifetime = lifetime.current;
      const result = await saveStudioApplication(organizationId, command);
      if (!active.current || requestLifetime !== lifetime.current)
        throw new StudioSaveError("STUDIO_WORKSPACE_CLOSED");
      if (result.kind === "available") {
        provisionalSaveDraft.current = result.draft;
        return result.draft;
      }
      throw new StudioSaveError(result.kind === "conflict"
        ? "DEFINITION_DRAFT_STALE_OR_MISSING"
        : result.kind === "refused" ? "DEFINITION_CONTEXT_REFUSED" : "STUDIO_SAVE_FAILED");
    },
  }));
  const [selection] = useState(() => createStudioSemanticSelectionStore({ rootId: draft.rootId, source: draft.source }));
  const [state, setState] = useState(() => history.getState());
  const [selected, setSelected] = useState(() => selection.getSelection());
  const [isReopening, setReopening] = useState(false);
  const [message, setMessage] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [pendingAppearance, setPendingAppearance] = useState(false);
  const appearancePending = useRef(false);
  const reportAppearancePending = useCallback((pending: boolean) => {
    if (appearancePending.current !== pending) previewGeneration.current += 1;
    appearancePending.current = pending;
    setPendingAppearance(pending);
  }, []);
  const [appearanceEpoch, setAppearanceEpoch] = useState(0);
  const [appearanceValidationEpoch, setAppearanceValidationEpoch] = useState(0);
  const [pendingComposition, setPendingComposition] = useState(false);
  const compositionPending = useRef(false);
  const reportCompositionPending = useCallback((pending: boolean) => {
    if (compositionPending.current !== pending) previewGeneration.current += 1;
    compositionPending.current = pending;
    setPendingComposition(pending);
  }, []);
  const [compositionEpoch, setCompositionEpoch] = useState(0);
  const [pendingFlowText, setPendingFlowText] = useState(false);
  const flowTextPending = useRef(false);
  const reportFlowTextPending = useCallback((pending: boolean) => {
    if (flowTextPending.current !== pending) previewGeneration.current += 1;
    flowTextPending.current = pending;
    setPendingFlowText(pending);
  }, []);
  const [flowEpoch, setFlowEpoch] = useState(0);
  const [pendingFlowAppend, setPendingFlowAppend] = useState(false);
  const flowAppendPending = useRef(false);
  const reportFlowAppendPending = useCallback((pending: boolean) => {
    if (flowAppendPending.current !== pending) previewGeneration.current += 1;
    flowAppendPending.current = pending;
    setPendingFlowAppend(pending);
  }, []);

  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    setWorkspaceLifetime(lifetime.current);
    const unsubscribeHistory = history.subscribe((next) => {
      previewGeneration.current += 1;
      selection.reconcile({ rootId: next.rootId, source: applicationSourceDocumentV2Schema.parse(next.source) });
      setState(next);
    });
    const unsubscribeSelection = selection.subscribe(setSelected);
    return () => {
      active.current = false;
      lifetime.current += 1;
      unsubscribeHistory();
      unsubscribeSelection();
    };
  }, [history, selection]);

  const source = useMemo(() => applicationSourceDocumentV2Schema.parse(state.source), [state.source]);
  const compositionContext = useMemo<StudioCompositionContext>(() => ({
    organizationId, rootId: state.rootId, key: draft.key, draftRevision: state.draftRevision,
    localLifetime: workspaceLifetime, source: state.source,
  }), [organizationId, state.rootId, draft.key, state.draftRevision, workspaceLifetime, state.source]);
  const inspector = resolveStudioSelectionInspectorContext({ rootId: state.rootId, source }, selected);
  const selectedPage = selected?.kind === "page"
    ? source.body.pages.find((page) => page.id === selected.pageAlias) : undefined;
  const editable = inspector.status === "resolved" &&
    (selected?.kind === "application" || (selected?.kind === "page" && selectedPage !== undefined));
  const currentLabel = selected?.kind === "application" ? source.body.name : selectedPage?.name ?? "";
  const selectionKey = selected === null ? "" : studioSemanticSelectionKey(selected);
  useEffect(() => { setLabel(currentLabel); setDescription(source.body.description); },
    [selectionKey, currentLabel, source.body.description]);
  const pendingLabels = editable && (label !== currentLabel ||
    (selected?.kind === "application" && description !== source.body.description));
  labelsPending.current = pendingLabels;

  const readPreviewContext = useCallback((): SavedHomepagePreviewContext | null => {
    const current = history.getState();
    const saved = savedPreviewDraft.current;
    if (!active.current || reopening.current || current.isSaving || current.isDirty ||
      labelsPending.current || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current ||
      saved.organizationId !== organizationId || saved.rootId !== current.rootId ||
      saved.key !== draft.key || saved.draftRevision !== current.draftRevision) return null;
    return {
      organizationId, rootId: current.rootId, key: saved.key, draftRevision: current.draftRevision,
      sourceFingerprint: saved.sourceFingerprint, source: current.source,
      localLifetime: lifetime.current, generation: previewGeneration.current,
    };
  }, [organizationId, draft.key, history]);

  const applyLabels = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || reopening.current || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current) return;
    const candidate = applicationSourceDocumentV2Schema.parse(structuredClone(state.source));
    if (selected?.kind === "application") {
      candidate.body.name = label.trim();
      candidate.body.description = description.trim();
    } else if (selected?.kind === "page") {
      const page = candidate.body.pages.find((item) => item.id === selected.pageAlias);
      if (page === undefined) return;
      page.name = label.trim();
    } else return;
    const parsed = applicationSourceDocumentV2Schema.safeParse(candidate);
    if (!parsed.success) { setMessage("Enter a valid non-empty label and description within their limits."); return; }
    history.edit(parsed.data);
    setLabel(selected?.kind === "application" ? parsed.data.body.name
      : parsed.data.body.pages.find((page) => page.id === selectedPage?.id)?.name ?? currentLabel);
    setDescription(parsed.data.body.description);
    setMessage("Labels applied to local history. Save to persist this change.");
  };

  const save = async () => {
    if (reopening.current || history.getState().isSaving || pendingLabels || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current) return;
    const requestLifetime = lifetime.current;
    provisionalSaveDraft.current = null;
    const result = await history.save();
    if (!active.current || requestLifetime !== lifetime.current) return;
    const returned = readProvisionalSaveDraft();
    const current = history.getState();
    // The writer response is evidence only after the unchanged history controller accepts it.
    if (result.kind === "saved" && returned !== null && !current.isDirty &&
      returned.organizationId === organizationId && returned.rootId === current.rootId &&
      returned.key === draft.key && returned.draftRevision === result.draftRevision &&
      current.draftRevision === result.draftRevision) {
      savedPreviewDraft.current = returned;
      previewGeneration.current += 1;
    }
    provisionalSaveDraft.current = null;
    setMessage(result.kind === "saved" ? `Saved revision ${result.draftRevision}.`
      : result.kind === "conflict" ? "The saved draft changed. Local edits are preserved. Reopen explicitly to use the current saved draft."
        : result.kind === "refused" ? "The current draft permission or source was refused. Local edits are preserved."
          : result.kind === "busy" ? "A save is already in progress."
            : "The save could not be verified. Local edits are preserved; reopen or try again.");
  };

  const reopen = async () => {
    if (reopening.current || history.getState().isSaving) return;
    if ((history.getState().isDirty || pendingLabels || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current) &&
      !window.confirm("Discard unsaved changes and reopen the saved draft?")) return;
    const requestLifetime = lifetime.current;
    reopening.current = true;
    previewGeneration.current += 1;
    setAppearanceValidationEpoch((value) => value + 1);
    setReopening(true);
    setMessage("Reading the saved draft with current permissions…");
    try {
      const result = await reopenStudioApplication(organizationId, draft.rootId);
      if (!active.current || requestLifetime !== lifetime.current) return;
      if (result.kind !== "available" || result.organizationId !== draft.organizationId || !history.reopen(result.draft)) {
        setMessage("The saved draft could not be reopened. Local edits are preserved.");
        return;
      }
      savedPreviewDraft.current = result.draft;
      previewGeneration.current += 1;
      const reopenedSelection = selection.getSelection();
      const reopenedPageAlias = reopenedSelection?.kind === "page" ? reopenedSelection.pageAlias : undefined;
      setLabel(reopenedSelection?.kind === "application" ? result.draft.source.body.name
        : result.draft.source.body.pages.find((page) => page.id === reopenedPageAlias)?.name ?? "");
      setDescription(result.draft.source.body.description);
      setCompositionEpoch((value) => value + 1);
      reportCompositionPending(false);
      setFlowEpoch((value) => value + 1);
      reportFlowTextPending(false);
      reportFlowAppendPending(false);
      setMessage(`Reopened saved revision ${result.draft.draftRevision}.`);
    } catch {
      if (active.current && requestLifetime === lifetime.current)
        setMessage("The saved draft could not be reopened. Local edits are preserved.");
    } finally {
      reopening.current = false;
      if (active.current && requestLifetime === lifetime.current) setReopening(false);
    }
  };

  const outline = useMemo(() => projectStudioSemanticOutline({ rootId: state.rootId, source }),
    [state.rootId, source]);
  return <main className="space-y-6 p-6" aria-busy={state.isSaving || isReopening}>
    <header className="space-y-2"><h1 className="text-2xl font-semibold">Application draft: {source.body.name}</h1>
      <dl className="grid gap-1 break-all text-sm"><div><dt className="inline font-medium">Organization: </dt><dd className="inline">{draft.organizationId}</dd></div>
        <div><dt className="inline font-medium">Root: </dt><dd className="inline">{state.rootId}</dd></div>
        <div><dt className="inline font-medium">Key: </dt><dd className="inline">{draft.key}</dd></div>
        <div><dt className="inline font-medium">Draft revision: </dt><dd className="inline">{state.draftRevision}</dd></div></dl>
      <p>Draft editing workspace. Publishing, installing and assigning roles remain separate.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!state.canUndo || isReopening || pendingLabels || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend} onClick={() => {
          if (!reopening.current && !pendingLabels && !appearancePending.current && !compositionPending.current && !flowTextPending.current && !flowAppendPending.current) history.undo();
        }}>Undo</button>
        <button type="button" className={buttonClass} disabled={!state.canRedo || isReopening || pendingLabels || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend} onClick={() => {
          if (!reopening.current && !pendingLabels && !appearancePending.current && !compositionPending.current && !flowTextPending.current && !flowAppendPending.current) history.redo();
        }}>Redo</button>
        <button type="button" className={buttonClass} disabled={!state.isDirty || state.isSaving || isReopening || pendingLabels || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend} onClick={save}>Save draft</button>
        <button type="button" className={buttonClass} disabled={state.isSaving || isReopening} onClick={reopen}>Reopen saved draft</button>
      </div>
      <p role="status" aria-live="polite">{state.isSaving ? "Saving… Local history remains editable." : pendingFlowText
        ? "Apply or discard Flow text before saving or undoing." : pendingFlowAppend
        ? "Apply or discard Flow insertion inputs before saving or undoing." : pendingComposition
        ? "Apply or discard composition inputs before saving or undoing." : pendingAppearance
        ? "Apply or discard appearance edits before saving or undoing." : pendingLabels
        ? "Apply or discard the inspector text before saving or undoing." : state.isDirty
          ? "Unsaved local changes." : "Local history matches the saved baseline."} {message}</p>
    </header>
    <div className="grid gap-6 lg:grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_minmax(16rem,1fr)]">
      <nav aria-label="Application outline" className="space-y-3"><h2 className="font-semibold">Outline</h2>
        <ul><Outline node={outline} selectedKey={selectionKey} choose={(node) => {
          if (reopening.current || history.getState().isSaving || ((pendingLabels || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current) &&
            !window.confirm("Discard unapplied inspector, appearance, composition and Flow edits and change selection?"))) return;
          if (!selection.select(node.selection)) return;
          setAppearanceEpoch((value) => value + 1);
          reportAppearancePending(false);
          setCompositionEpoch((value) => value + 1);
          reportCompositionPending(false);
          setFlowEpoch((value) => value + 1);
          reportFlowTextPending(false);
          reportFlowAppendPending(false);
          setLabel(currentLabel);
          setDescription(source.body.description);
        }} /></ul></nav>
      <section className="space-y-3 rounded border border-border p-4" aria-label="Selected item">
        <h2 className="font-semibold">{inspector.status === "resolved" ? inspector.descriptor.label : "Select an item"}</h2>
        {selectedPage?.type === "dashboard" && <p>This dashboard's authored composition is preserved. This minimum host edits labels; it does not render or execute application data, events or actions.</p>}
        {selected?.kind === "application" && <p>{source.body.description}</p>}
        {(selected?.kind === "placement" || selected?.kind === "page") && inspector.status === "resolved" &&
          <ApplicationCompositionEditor key={compositionEpoch} context={compositionContext}
            selection={selected} disabled={isReopening || state.isSaving || pendingLabels || pendingAppearance || pendingFlowText || pendingFlowAppend || workspaceLifetime === 0}
            onPendingChange={reportCompositionPending} onCommand={(expected, expectedSelection, command) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || reopening.current || current.isSaving || pendingLabels || appearancePending.current || flowTextPending.current || flowAppendPending.current ||
                (command.kind === "remove" && compositionPending.current) ||
                currentSelection === null || studioSemanticSelectionKey(currentSelection) !== studioSemanticSelectionKey(expectedSelection))
                return "stale";
              const currentContext: StudioCompositionContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioCompositionCommand(currentContext, expected, currentSelection, command);
              if (result.kind !== "applied") return result.kind;
              // No async boundary: still require the same history source and lifetime at the edit.
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || reopening.current || latest.isSaving || flowTextPending.current || flowAppendPending.current || latest.source !== current.source ||
                (command.kind === "remove" && (pendingLabels || appearancePending.current || compositionPending.current)) ||
                latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
                latestSelection === null ||
                studioSemanticSelectionKey(latestSelection) !== studioSemanticSelectionKey(expectedSelection) ||
                lifetime.current !== currentContext.localLifetime) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Composition applied to local history. Save to persist it.");
              return "applied";
            }} />}
        {selected?.kind === "flow" && inspector.status === "resolved" &&
          <ApplicationFlowEditor key={flowEpoch} context={compositionContext} selection={selected}
            disabled={isReopening || state.isSaving || pendingLabels || pendingAppearance || pendingComposition || workspaceLifetime === 0}
            onPendingChange={reportFlowTextPending} onAppendPendingChange={reportFlowAppendPending}
            onCommand={(expected, expectedSelection, command) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || reopening.current || current.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowAppendPending.current) return "stale";
              const currentContext: StudioFlowTextContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioFlowTextCommand(currentContext, expected, currentSelection, expectedSelection, command);
              if (result.kind !== "applied") return result.kind;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || reopening.current || latest.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowAppendPending.current || latest.source !== current.source ||
                latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
                lifetime.current !== currentContext.localLifetime || latestSelection?.kind !== "flow" ||
                latestSelection.flowAlias !== expectedSelection.flowAlias) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Flow text applied to local history. Save to persist it.");
              return "applied";
            }} onAppend={(expected, expectedSelection, command) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || reopening.current || current.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current) return "stale";
              const currentContext: StudioFlowTextContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioFlowPresentationCommand(currentContext, expected, currentSelection, expectedSelection, command);
              if (result.kind !== "applied") return result.kind;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || reopening.current || latest.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current || latest.source !== current.source ||
                latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
                lifetime.current !== currentContext.localLifetime || latestSelection?.kind !== "flow" ||
                latestSelection.flowAlias !== expectedSelection.flowAlias) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Presentation task appended to local history. Save to persist it.");
              return "applied";
            }} onMove={(expected, expectedSelection, command, isCurrentTarget) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || reopening.current || current.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current ||
                flowAppendPending.current || !isCurrentTarget()) return "stale";
              const currentContext: StudioFlowTextContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioFlowPresentationMoveCommand(currentContext, expected, currentSelection, expectedSelection, command);
              if (result.kind !== "applied") return result.kind;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || reopening.current || latest.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current ||
                flowAppendPending.current || !isCurrentTarget() || latest.source !== current.source ||
                latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
                lifetime.current !== currentContext.localLifetime || latestSelection?.kind !== "flow" ||
                latestSelection.flowAlias !== expectedSelection.flowAlias) return "stale";
              // Resolve both identities and adjacency again on the same source immediately at the edit.
              const stillAdjacent = projectStudioFlowPresentationMoves(currentContext, expectedSelection, command.taskId, command.taskPath)
                .some((option) => option.direction === command.direction && option.neighborId === command.neighborId &&
                  JSON.stringify(option.neighborPath) === JSON.stringify(command.neighborPath));
              if (!stillAdjacent) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Presentation task order applied to local history. Save to persist it.");
              return "applied";
            }} />}
        <p className="text-sm">The outline and inspector select the same authored alias. Other definition content is retained without alteration.</p>
      </section>
      <aside className="space-y-3" aria-label="Selection inspector"><h2 className="font-semibold">Inspector</h2>
        {inspector.status === "resolved" && <p className="break-all text-sm">{inspector.descriptor.kind}: {inspector.descriptor.alias}</p>}
        {editable ? <form className="space-y-3" onSubmit={applyLabels}>
          <label className="block space-y-1"><span>Selected item name</span>
            <input className={inputClass} required maxLength={selected?.kind === "application" ? 120 : 60}
              disabled={isReopening || pendingComposition || pendingFlowText || pendingFlowAppend} value={label} onChange={(event) => {
                labelsPending.current = true;
                previewGeneration.current += 1;
                setLabel(event.target.value);
              }} /></label>
          {selected?.kind === "application" && <label className="block space-y-1"><span>Application description</span>
            <textarea className={inputClass} required maxLength={1000} disabled={isReopening || pendingComposition || pendingFlowText || pendingFlowAppend}
              value={description} onChange={(event) => {
                labelsPending.current = true;
                previewGeneration.current += 1;
                setDescription(event.target.value);
              }} /></label>}
          <button className={buttonClass} disabled={isReopening || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend} type="submit">Apply labels</button>
          <button className={buttonClass} disabled={isReopening || !pendingLabels} type="button" onClick={() => {
            setLabel(currentLabel); setDescription(source.body.description);
          }}>Discard inspector text</button>
          <p className="text-sm">Apply records one local history entry. Save persists it through the current protected writer.</p>
        </form> : <p>{selected?.kind === "flow"
          ? "Select a task in the Flow outline to inspect its supported presentation text."
          : "This item is read-only in the minimum host."}</p>}
        {selected?.kind === "application" && inspector.status === "resolved" &&
          <ApplicationAppearanceEditor key={appearanceEpoch} organizationId={organizationId}
            rootId={state.rootId} draftRevision={state.draftRevision} source={source}
            validationEpoch={appearanceValidationEpoch}
            disabled={isReopening || state.isSaving || pendingLabels || pendingComposition || pendingFlowText || pendingFlowAppend} onPendingChange={reportAppearancePending}
            onApply={(expected, next) => {
              const current = history.getState();
              if (reopening.current || current.isSaving || pendingLabels || compositionPending.current || flowTextPending.current || flowAppendPending.current || current.rootId !== state.rootId ||
                  current.draftRevision !== state.draftRevision || current.source !== state.source ||
                  expected !== source) return false;
              const applied = history.edit(next);
              if (applied) setMessage("Appearance applied to local history. Save to persist it.");
              return applied;
            }} />}
      </aside>
    </div>
    <ApplicationDraftPreview context={readPreviewContext()} readContext={readPreviewContext} />
  </main>;
}
