"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { applicationSourceDocumentV2Schema } from "@vortex/contracts";
import {
  createStudioApplicationDraftHistoryController,
  createStudioSemanticSelectionStore,
  projectStudioSemanticOutline,
  resolveStudioSelectionInspectorContext,
  studioSemanticSelectionKey,
  type StudioSemanticOutlineNode,
  type StudioStoredApplicationDraft,
} from "@vortex/studio";
import { createStudioApplication, reopenStudioApplication, saveStudioApplication } from "../actions";
import { minimumApplicationSource, type MinimumApplicationInputs } from "../_lib/minimum-application-source";

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
      {textInput("key", "Application key", 120, "Use lowercase namespaced segments, for example team.workspace. The derived .home.read permission must also fit the 120-character key limit.")}
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
  const [history] = useState(() => createStudioApplicationDraftHistoryController(draft, {
    saveDraft: async (command) => {
      const requestLifetime = lifetime.current;
      const result = await saveStudioApplication(organizationId, command);
      if (!active.current || requestLifetime !== lifetime.current)
        throw new StudioSaveError("STUDIO_WORKSPACE_CLOSED");
      if (result.kind === "available") return result.draft;
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

  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    const unsubscribeHistory = history.subscribe((next) => {
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

  const applyLabels = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || reopening.current) return;
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
    if (reopening.current || pendingLabels) return;
    const requestLifetime = lifetime.current;
    const result = await history.save();
    if (!active.current || requestLifetime !== lifetime.current) return;
    setMessage(result.kind === "saved" ? `Saved revision ${result.draftRevision}.`
      : result.kind === "conflict" ? "The saved draft changed. Local edits are preserved. Reopen explicitly to use the current saved draft."
        : result.kind === "refused" ? "The current draft permission or source was refused. Local edits are preserved."
          : result.kind === "busy" ? "A save is already in progress."
            : "The save could not be verified. Local edits are preserved; reopen or try again.");
  };

  const reopen = async () => {
    if (reopening.current || history.getState().isSaving) return;
    if ((history.getState().isDirty || pendingLabels) &&
      !window.confirm("Discard unsaved changes and reopen the saved draft?")) return;
    const requestLifetime = lifetime.current;
    reopening.current = true;
    setReopening(true);
    setMessage("Reading the saved draft with current permissions…");
    try {
      const result = await reopenStudioApplication(organizationId, draft.rootId);
      if (!active.current || requestLifetime !== lifetime.current) return;
      if (result.kind !== "available" || result.organizationId !== draft.organizationId || !history.reopen(result.draft)) {
        setMessage("The saved draft could not be reopened. Local edits are preserved.");
        return;
      }
      const reopenedSelection = selection.getSelection();
      const reopenedPageAlias = reopenedSelection?.kind === "page" ? reopenedSelection.pageAlias : undefined;
      setLabel(reopenedSelection?.kind === "application" ? result.draft.source.body.name
        : result.draft.source.body.pages.find((page) => page.id === reopenedPageAlias)?.name ?? "");
      setDescription(result.draft.source.body.description);
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
        <button type="button" className={buttonClass} disabled={!state.canUndo || isReopening || pendingLabels} onClick={() => {
          if (!reopening.current && !pendingLabels) history.undo();
        }}>Undo</button>
        <button type="button" className={buttonClass} disabled={!state.canRedo || isReopening || pendingLabels} onClick={() => {
          if (!reopening.current && !pendingLabels) history.redo();
        }}>Redo</button>
        <button type="button" className={buttonClass} disabled={!state.isDirty || state.isSaving || isReopening || pendingLabels} onClick={save}>Save draft</button>
        <button type="button" className={buttonClass} disabled={state.isSaving || isReopening} onClick={reopen}>Reopen saved draft</button>
      </div>
      <p role="status" aria-live="polite">{state.isSaving ? "Saving… Local history remains editable." : pendingLabels
        ? "Apply or discard the inspector text before saving or undoing." : state.isDirty
          ? "Unsaved local changes." : "Local history matches the saved baseline."} {message}</p>
    </header>
    <div className="grid gap-6 lg:grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_minmax(16rem,1fr)]">
      <nav aria-label="Application outline" className="space-y-3"><h2 className="font-semibold">Outline</h2>
        <ul><Outline node={outline} selectedKey={selectionKey} choose={(node) => {
          if (reopening.current || (pendingLabels &&
            !window.confirm("Discard unapplied inspector text and change selection?"))) return;
          setLabel(currentLabel);
          setDescription(source.body.description);
          selection.select(node.selection);
        }} /></ul></nav>
      <section className="space-y-3 rounded border border-border p-4" aria-label="Selected item">
        <h2 className="font-semibold">{inspector.status === "resolved" ? inspector.descriptor.label : "Select an item"}</h2>
        {selectedPage?.type === "dashboard" && <p>This dashboard's authored composition is preserved. This minimum host edits labels; it does not render or execute application data, events or actions.</p>}
        {selected?.kind === "application" && <p>{source.body.description}</p>}
        <p className="text-sm">The outline and inspector select the same authored alias. Other definition content is retained without alteration.</p>
      </section>
      <aside className="space-y-3" aria-label="Selection inspector"><h2 className="font-semibold">Inspector</h2>
        {inspector.status === "resolved" && <p className="break-all text-sm">{inspector.descriptor.kind}: {inspector.descriptor.alias}</p>}
        {editable ? <form className="space-y-3" onSubmit={applyLabels}>
          <label className="block space-y-1"><span>Selected item name</span>
            <input className={inputClass} required maxLength={selected?.kind === "application" ? 120 : 60}
              disabled={isReopening} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
          {selected?.kind === "application" && <label className="block space-y-1"><span>Application description</span>
            <textarea className={inputClass} required maxLength={1000} disabled={isReopening}
              value={description} onChange={(event) => setDescription(event.target.value)} /></label>}
          <button className={buttonClass} disabled={isReopening} type="submit">Apply labels</button>
          <button className={buttonClass} disabled={isReopening || !pendingLabels} type="button" onClick={() => {
            setLabel(currentLabel); setDescription(source.body.description);
          }}>Discard inspector text</button>
          <p className="text-sm">Apply records one local history entry. Save persists it through the current protected writer.</p>
        </form> : <p>This item is read-only in the minimum host.</p>}
      </aside>
    </div>
  </main>;
}
