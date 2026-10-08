"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { applicationSourceDocumentV2Schema, canonicalJson,
  prepareDefinitionPublicationResultSchema, publishDefinitionResultSchema,
  type DefinitionPublicationConfirmation, type PublishDefinitionResult } from "@vortex/contracts";
import {
  applyStudioCompositionCommand,
  applyStudioVisibilityCondition,
  applyStudioFlowTextCommand,
  applyStudioFlowPresentationCommand,
  applyStudioFlowPresentationMoveCommand,
  applyStudioFlowPresentationRemovalCommand,
  applyStudioFlowCalculateCommand,
  createStudioApplicationDraftHistoryController,
  createStudioSemanticSelectionStore,
  projectStudioSemanticOutline,
  projectStudioFlowPresentationMoves,
  projectStudioFlowPresentationRemoval,
  resolveStudioSelectionInspectorContext,
  studioSemanticSelectionKey,
  type StudioSemanticOutlineNode,
  type StudioStoredApplicationDraft,
  type StudioCompositionContext,
  type StudioFlowTextContext,
} from "@vortex/studio";
import { createStudioApplication, reopenStudioApplication, saveStudioApplication,
  prepareStudioApplicationPublication, publishStudioApplication } from "../actions";
import { minimumApplicationSource, type MinimumApplicationInputs } from "../_lib/minimum-application-source";
import { ApplicationAppearanceEditor } from "./application-appearance-editor";
import { ApplicationCompositionEditor } from "./application-composition-editor";
import { ApplicationVisibilityConditionEditor, type StudioVisibilityWorkspaceSnapshot } from "./application-visibility-condition-editor";
import { ApplicationFlowEditor } from "./application-flow-editor";
import { ApplicationDraftPreview, type SavedHomepagePreviewContext } from "./application-draft-preview";
import { ApplicationSourceImport } from "./application-source-import";
import { ApplicationSearchEditor } from "./application-search-editor";
import type { StudioApplicationSearchMetadata } from "../../_lib/studio-application-draft";
import {
  sameStudioApplicationSourceImportSnapshot,
  type StudioApplicationSourceImportSnapshot,
} from "../_lib/application-source-import";

type WorkspaceProps =
  | Readonly<{ mode: "new"; organizationId: string }>
  | Readonly<{ mode: "existing"; organizationId: string; draft: StudioStoredApplicationDraft }>;

type PublicationSnapshot = Readonly<{
  organizationId: string; rootId: string; key: string; draftRevision: number;
  sourceFingerprint: string; source: object; selectionKey: string;
  lifetime: number; generation: number;
}>;
const samePublicationSnapshot = (left: PublicationSnapshot, right: PublicationSnapshot | null) =>
  right !== null && left.organizationId === right.organizationId && left.rootId === right.rootId &&
  left.key === right.key && left.draftRevision === right.draftRevision &&
  left.sourceFingerprint === right.sourceFingerprint && left.source === right.source &&
  left.selectionKey === right.selectionKey && left.lifetime === right.lifetime && left.generation === right.generation;

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

function Outline({ node, selectedKey, choose, disabled = false }: {
  node: StudioSemanticOutlineNode;
  selectedKey: string;
  choose: (node: StudioSemanticOutlineNode) => void;
  disabled?: boolean;
}) {
  return <li className="space-y-1">
    {node.selection === null ? <span className="text-sm text-muted-foreground">{node.label}</span>
      : <button type="button" disabled={disabled} className={`${buttonClass} w-full text-left`}
        aria-pressed={selectedKey === studioSemanticSelectionKey(node.selection)} onClick={() => choose(node)}>
        {node.label} <span className="text-xs text-muted-foreground">({node.kind})</span>
      </button>}
    {node.children.length > 0 && <ul className="space-y-1 border-l border-border pl-3">
      {node.children.map((child) => <Outline key={child.key} node={child} selectedKey={selectedKey} choose={choose} disabled={disabled} />)}
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
  const publicationPending = useRef(false);
  const publicationEpoch = useRef(0);
  const publicationRequest = useRef<{ epoch: number; cancelled: boolean } | null>(null);
  const [isPublishing, setPublishing] = useState(false);
  const [publicationNote, setPublicationNote] = useState("");
  const [publicationMessage, setPublicationMessage] = useState("");
  const [publishedPublication, setPublishedPublication] = useState<PublishDefinitionResult | null>(null);
  const [preparedPublication, setPreparedPublication] = useState<Readonly<{
    confirmation: DefinitionPublicationConfirmation; snapshot: PublicationSnapshot;
  }> | null>(null);
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
  const [searchMetadata, setSearchMetadata] = useState<StudioApplicationSearchMetadata | null>(null);
  const [pendingSearch, setPendingSearch] = useState(false);
  const searchPending = useRef(false);
  const searchRefresh = useRef(0);
  const [refreshingSearch, setRefreshingSearch] = useState(false);
  const reportSearchPending = useCallback((pending: boolean) => {
    if (searchPending.current !== pending) previewGeneration.current += 1;
    searchPending.current = pending; setPendingSearch(pending);
  }, []);
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
  const [pendingCondition, setPendingCondition] = useState(false);
  const conditionPending = useRef(false);
  const [conditionEpoch, setConditionEpoch] = useState(0);
  const reportConditionPending = useCallback((pending: boolean) => {
    if (conditionPending.current !== pending) previewGeneration.current += 1;
    conditionPending.current = pending;
    setPendingCondition(pending);
  }, []);
  // Text and Calculate share this synchronous guard; either blocks other workspace edits.
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
  const sourceImportPending = useRef(false);
  const [pendingSourceImport, setPendingSourceImport] = useState(false);
  const sourceImportEpoch = useRef(0);
  const [sourceImportPanelEpoch, setSourceImportPanelEpoch] = useState(0);
  const sourceImportGeneration = useRef(0);
  const reportSourceImportPending = useCallback((pending: boolean, epoch: number) => {
    if (epoch !== sourceImportEpoch.current) return;
    if (sourceImportPending.current !== pending) previewGeneration.current += 1;
    sourceImportPending.current = pending;
    setPendingSourceImport(pending);
  }, []);
  const discardSourceImport = () => {
    sourceImportEpoch.current += 1;
    setSourceImportPanelEpoch(sourceImportEpoch.current);
    reportSourceImportPending(false, sourceImportEpoch.current);
  };

  const readSourceImportSnapshot = (): StudioApplicationSourceImportSnapshot | null => {
    const current = history.getState();
    const saved = savedPreviewDraft.current;
    if (!active.current || publicationPending.current || reopening.current || current.isSaving ||
      searchPending.current || labelsPending.current || appearancePending.current || compositionPending.current || conditionPending.current ||
      flowTextPending.current || flowAppendPending.current || saved.organizationId !== organizationId ||
      saved.rootId !== current.rootId || saved.key !== draft.key || saved.draftRevision !== current.draftRevision) return null;
    const currentSelection = selection.getSelection();
    return {
      organizationId, rootId: current.rootId, key: draft.key, rootAlias: current.source.root_alias,
      draftRevision: current.draftRevision, savedSourceFingerprint: saved.sourceFingerprint,
      source: current.source, localLifetime: lifetime.current, generation: sourceImportGeneration.current,
      selectionKey: currentSelection === null ? "" : studioSemanticSelectionKey(currentSelection),
    };
  };

  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    setWorkspaceLifetime(lifetime.current);
    const unsubscribeHistory = history.subscribe((next) => {
      sourceImportGeneration.current += 1;
      publicationEpoch.current += 1;
      setPreparedPublication(null);
      previewGeneration.current += 1;
      selection.reconcile({ rootId: next.rootId, source: applicationSourceDocumentV2Schema.parse(next.source) });
      setState(next);
    });
    const unsubscribeSelection = selection.subscribe((next) => {
      sourceImportGeneration.current += 1;
      publicationEpoch.current += 1;
      setPreparedPublication(null);
      setSelected(next);
    });
    return () => {
      active.current = false;
      lifetime.current += 1;
      publicationEpoch.current += 1;
      if (publicationRequest.current !== null) publicationRequest.current.cancelled = true;
      unsubscribeHistory();
      unsubscribeSelection();
    };
  }, [history, selection]);

  const source = useMemo(() => applicationSourceDocumentV2Schema.parse(state.source), [state.source]);
  const refreshSearchMetadata = async () => {
    const current = history.getState();
    if (!active.current || current.isDirty || current.isSaving || reopening.current || publicationPending.current ||
        searchPending.current || sourceImportPending.current || labelsPending.current || appearancePending.current ||
        compositionPending.current || conditionPending.current || flowTextPending.current || flowAppendPending.current) return;
    const expectedSource = current.source;
    const expectedLifetime = lifetime.current;
    const epoch = ++searchRefresh.current;
    const saved = savedPreviewDraft.current;
    setSearchMetadata(null); setRefreshingSearch(true);
    try {
      const result = await reopenStudioApplication(organizationId, current.rootId);
      const latest = history.getState();
      if (!active.current || lifetime.current !== expectedLifetime || epoch !== searchRefresh.current ||
          latest.source !== expectedSource || latest.draftRevision !== current.draftRevision || latest.isDirty || latest.isSaving ||
          reopening.current || publicationPending.current || searchPending.current || sourceImportPending.current ||
          labelsPending.current || appearancePending.current || compositionPending.current || conditionPending.current ||
          flowTextPending.current || flowAppendPending.current ||
          result.kind !== "available" || result.searchMetadata === null || result.organizationId !== organizationId ||
          result.draft.rootId !== current.rootId || result.draft.key !== draft.key || result.draft.draftRevision !== current.draftRevision ||
          result.draft.sourceFingerprint !== saved.sourceFingerprint || canonicalJson(result.draft.source) !== canonicalJson(expectedSource)) return;
      const metadata = result.searchMetadata;
      if (metadata.organizationId !== organizationId || metadata.rootId !== current.rootId || metadata.draftRevision !== current.draftRevision ||
          metadata.sourceFingerprint !== saved.sourceFingerprint || metadata.bindingsSignature !== JSON.stringify(expectedSource.body.module_bindings)) return;
      setSearchMetadata(metadata);
    } catch {
      if (active.current && lifetime.current === expectedLifetime && epoch === searchRefresh.current) setSearchMetadata(null);
    }
    finally { if (active.current && epoch === searchRefresh.current) setRefreshingSearch(false); }
  };
  const currentSearchMetadata = searchMetadata !== null && searchMetadata.rootId === state.rootId &&
    searchMetadata.draftRevision === state.draftRevision && searchMetadata.sourceFingerprint === savedPreviewDraft.current.sourceFingerprint &&
    searchMetadata.bindingsSignature === JSON.stringify(source.body.module_bindings) &&
    canonicalJson(state.source) === canonicalJson(savedPreviewDraft.current.source) ? searchMetadata : null;
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

  // Read refs synchronously at every request and completion; rendered disabled state is advisory.
  const readPublicationSnapshot = (): PublicationSnapshot | null => {
    const current = history.getState();
    const saved = savedPreviewDraft.current;
    if (!active.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || current.isDirty ||
      labelsPending.current || appearancePending.current || compositionPending.current ||
      conditionPending.current || flowTextPending.current || flowAppendPending.current ||
      saved.organizationId !== organizationId || saved.rootId !== current.rootId ||
      saved.key !== draft.key || saved.draftRevision !== current.draftRevision ||
      canonicalJson(saved.source) !== canonicalJson(current.source)) return null;
    const currentSelection = selection.getSelection();
    return { organizationId, rootId: current.rootId, key: saved.key,
      draftRevision: current.draftRevision, sourceFingerprint: saved.sourceFingerprint,
      source: current.source, selectionKey: currentSelection === null ? "" : studioSemanticSelectionKey(currentSelection),
      lifetime: lifetime.current, generation: previewGeneration.current };
  };

  useEffect(() => {
    setPreparedPublication((prepared) => prepared !== null &&
      !samePublicationSnapshot(prepared.snapshot, readPublicationSnapshot()) ? null : prepared);
  }, [state, selected, pendingLabels, pendingAppearance, pendingComposition, pendingCondition,
    pendingFlowText, pendingFlowAppend, pendingSourceImport, workspaceLifetime, organizationId, draft.key]);

  const cancelPublication = () => {
    publicationEpoch.current += 1;
    previewGeneration.current += 1;
    setPreparedPublication(null);
    if (publicationRequest.current !== null) publicationRequest.current.cancelled = true;
    setPublicationMessage(publicationPending.current
      ? "Response discarded. The request may still complete; editing remains locked until it settles. Reopen explicitly to inspect the saved result."
      : "Publication confirmation cancelled. Local inputs are preserved.");
  };

  const requestPublication = async (mode: "prepare" | "publish") => {
    if (publicationPending.current || readPublicationSnapshot() === null) return;
    const prepared = preparedPublication;
    const note = publicationNote.trim();
    if (mode === "publish" && (prepared === null || note.length < 1 || note.length > 2000 ||
      !samePublicationSnapshot(prepared.snapshot, readPublicationSnapshot()))) {
      setPreparedPublication(null);
      setPublicationMessage("Prepare the current saved draft and enter a release note before confirming.");
      return;
    }
    publicationPending.current = true;
    previewGeneration.current += 1;
    const snapshot = readPublicationSnapshot();
    if (snapshot === null) { publicationPending.current = false; return; }
    const request = { epoch: ++publicationEpoch.current, cancelled: false };
    publicationRequest.current = request;
    setPublishing(true);
    setPreparedPublication(null);
    setPublicationMessage(mode === "prepare" ? "Preparing the current saved draft…" : "Publishing the confirmed release…");
    try {
      if (mode === "prepare") {
        const result = await prepareStudioApplicationPublication(organizationId, {
          rootId: snapshot.rootId, expectedDraftRevision: snapshot.draftRevision,
        });
        if (!active.current || lifetime.current !== snapshot.lifetime || request.cancelled ||
          publicationRequest.current !== request || publicationEpoch.current !== request.epoch ||
          !samePublicationSnapshot(snapshot, readPublicationSnapshot())) return;
        const parsed = result.kind === "available" ? prepareDefinitionPublicationResultSchema.safeParse(result.preparation) : null;
        if (parsed?.success && parsed.data.confirmation.rootId === snapshot.rootId &&
          parsed.data.confirmation.expectedDraftRevision === snapshot.draftRevision &&
          parsed.data.confirmation.sourceFingerprint === snapshot.sourceFingerprint) {
          setPreparedPublication({ confirmation: parsed.data.confirmation, snapshot });
          setPublicationMessage("Preparation verified. Review the complete confirmation before explicitly publishing.");
        } else setPublicationMessage(result.kind === "no_change"
          ? "The saved draft has no publication change. No release was appended."
          : result.kind === "dependency_unavailable"
          ? "An exact published dependency is unavailable or incompatible. No publication was prepared."
          : "The current saved draft, permission or dependencies could not be prepared. Local inputs are preserved.");
      } else {
        if (prepared === null) return;
        const result = await publishStudioApplication(organizationId, {
          confirmation: prepared.confirmation, releaseNote: note,
        });
        if (!active.current || lifetime.current !== snapshot.lifetime || request.cancelled ||
          publicationRequest.current !== request || publicationEpoch.current !== request.epoch ||
          !samePublicationSnapshot(snapshot, readPublicationSnapshot())) return;
        const parsed = result.kind === "available" ? publishDefinitionResultSchema.safeParse(result.publication) : null;
        const confirmation = prepared.confirmation;
        if (parsed?.success && parsed.data.rootId === confirmation.rootId &&
          parsed.data.releaseRevision === confirmation.expectedDraftRevision &&
          parsed.data.releaseVersion === confirmation.assignedVersion &&
          parsed.data.contentFingerprint === confirmation.contentFingerprint &&
          parsed.data.resolutionFingerprint === confirmation.resolutionFingerprint &&
          parsed.data.comparisonFingerprint === confirmation.comparisonFingerprint &&
          canonicalJson(parsed.data.dependencyManifest) === canonicalJson(confirmation.dependencyManifest)) {
          previewGeneration.current += 1;
          setPublishedPublication(parsed.data);
          setPublicationMessage(`Published release ${parsed.data.releaseVersion} at revision ${parsed.data.releaseRevision}. Reopen explicitly before resolving new published metadata. No installation or adoption was requested.`);
        } else setPublicationMessage(result.kind === "conflict"
          ? "The saved draft or confirmation changed. Prepare again after explicitly reopening. Local inputs are preserved."
          : result.kind === "dependency_unavailable"
          ? "An exact dependency changed or became unavailable. Local inputs are preserved."
          : result.kind === "refused"
          ? "Current publication authority or source was refused. Local inputs are preserved."
          : result.kind === "no_change"
          ? "The saved draft has no publication change. No release was appended."
          : "Publication could not be verified. It may have completed; reopen explicitly before preparing again. Local inputs are preserved.");
      }
    } catch {
      if (active.current && lifetime.current === snapshot.lifetime && !request.cancelled)
        setPublicationMessage("The request could not be verified. Reopen explicitly to inspect saved state. Local inputs are preserved.");
    } finally {
      // Cancellation never releases a potentially mutating request early or clears another owner.
      if (publicationRequest.current === request) {
        publicationRequest.current = null;
        publicationPending.current = false;
        if (active.current && lifetime.current === snapshot.lifetime) setPublishing(false);
      }
    }
  };

  const readPreviewContext = useCallback((): SavedHomepagePreviewContext | null => {
    const current = history.getState();
    const saved = savedPreviewDraft.current;
    if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || current.isDirty ||
      labelsPending.current || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current ||
      saved.organizationId !== organizationId || saved.rootId !== current.rootId ||
      saved.key !== draft.key || saved.draftRevision !== current.draftRevision) return null;
    return {
      organizationId, rootId: current.rootId, key: saved.key, draftRevision: current.draftRevision,
      sourceFingerprint: saved.sourceFingerprint, source: current.source,
      localLifetime: lifetime.current, generation: previewGeneration.current,
    };
  }, [organizationId, draft.key, history]);

  const readVisibilitySnapshot = useCallback((): StudioVisibilityWorkspaceSnapshot | null => {
    const current = history.getState();
    const currentSelection = selection.getSelection();
    if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || currentSelection?.kind !== "placement") return null;
    return { context: { organizationId, rootId: current.rootId, key: draft.key,
      draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source },
      selection: currentSelection, saved: savedPreviewDraft.current };
  }, [organizationId, draft.key, history, selection]);

  const applyLabels = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || conditionPending.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current) return;
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
    if (publicationPending.current || (sourceImportPending.current || searchPending.current) || conditionPending.current || reopening.current) return;
    history.edit(parsed.data);
    setLabel(selected?.kind === "application" ? parsed.data.body.name
      : parsed.data.body.pages.find((page) => page.id === selectedPage?.id)?.name ?? currentLabel);
    setDescription(parsed.data.body.description);
    setMessage("Labels applied to local history. Save to persist this change.");
  };

  const save = async () => {
    if (publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || history.getState().isSaving || conditionPending.current || pendingLabels || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current) return;
    publicationEpoch.current += 1;
    setPreparedPublication(null);
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
    if (publicationPending.current || reopening.current || history.getState().isSaving) return;
    if ((history.getState().isDirty || (sourceImportPending.current || searchPending.current) || pendingLabels || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current || conditionPending.current) &&
      !window.confirm("Discard unsaved changes and reopen the saved draft?")) return;
    publicationEpoch.current += 1;
    setPreparedPublication(null);
    const requestLifetime = lifetime.current;
    reopening.current = true;
    sourceImportGeneration.current += 1;
    let completionLifetime = requestLifetime;
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
      setSearchMetadata(result.searchMetadata);
      searchRefresh.current += 1;
      discardSourceImport();
      lifetime.current += 1;
      completionLifetime = lifetime.current;
      setWorkspaceLifetime(lifetime.current);
      setConditionEpoch((value) => value + 1);
      reportConditionPending(false);
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
      if (active.current && completionLifetime === lifetime.current) setReopening(false);
    }
  };

  const outline = useMemo(() => projectStudioSemanticOutline({ rootId: state.rootId, source }),
    [state.rootId, source]);
  return <main className="space-y-6 p-6" aria-busy={isPublishing || state.isSaving || isReopening}>
    <header className="space-y-2"><h1 className="text-2xl font-semibold">Application draft: {source.body.name}</h1>
      <dl className="grid gap-1 break-all text-sm"><div><dt className="inline font-medium">Organization: </dt><dd className="inline">{draft.organizationId}</dd></div>
        <div><dt className="inline font-medium">Root: </dt><dd className="inline">{state.rootId}</dd></div>
        <div><dt className="inline font-medium">Key: </dt><dd className="inline">{draft.key}</dd></div>
        <div><dt className="inline font-medium">Draft revision: </dt><dd className="inline">{state.draftRevision}</dd></div></dl>
      <p>Save draft changes before preparing a release. Publishing does not install or adopt it.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!state.canUndo || isPublishing || pendingSearch || pendingSourceImport || isReopening || pendingLabels || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend || pendingCondition} onClick={() => {
          if (!publicationPending.current && !sourceImportPending.current && !searchPending.current && !reopening.current && !conditionPending.current && !pendingLabels && !appearancePending.current && !compositionPending.current && !flowTextPending.current && !flowAppendPending.current) history.undo();
        }}>Undo</button>
        <button type="button" className={buttonClass} disabled={!state.canRedo || isPublishing || pendingSearch || pendingSourceImport || isReopening || pendingLabels || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend || pendingCondition} onClick={() => {
          if (!publicationPending.current && !sourceImportPending.current && !searchPending.current && !reopening.current && !conditionPending.current && !pendingLabels && !appearancePending.current && !compositionPending.current && !flowTextPending.current && !flowAppendPending.current) history.redo();
        }}>Redo</button>
        <button type="button" className={buttonClass} disabled={!state.isDirty || state.isSaving || isPublishing || pendingSearch || pendingSourceImport || isReopening || pendingLabels || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend || pendingCondition} onClick={save}>Save draft</button>
        <button type="button" className={buttonClass} disabled={isPublishing || state.isSaving || isReopening} onClick={reopen}>Reopen saved draft</button>
      </div>
      <p role="status" aria-live="polite">{state.isSaving ? "Saving… Local history remains editable." : pendingSearch
        ? "Apply or discard Search edits before saving or changing other editor content." : pendingSourceImport
        ? "Apply or discard source import inputs before saving or changing other editor content." : pendingCondition
        ? "Apply or discard visibility edits before saving or undoing." : pendingFlowText
        ? "Apply or discard Flow text or Calculate inputs before saving or undoing." : pendingFlowAppend
        ? "Apply or discard Flow insertion inputs before saving or undoing." : pendingComposition
        ? "Apply or discard composition inputs before saving or undoing." : pendingAppearance
        ? "Apply or discard appearance edits before saving or undoing." : pendingLabels
        ? "Apply or discard the inspector text before saving or undoing." : state.isDirty
          ? "Unsaved local changes." : "Local history matches the saved baseline."} {message}</p>
    </header>
    <ApplicationSearchEditor source={source} metadata={currentSearchMetadata}
      disabled={isPublishing || state.isSaving || isReopening || refreshingSearch || state.isDirty || pendingSourceImport || pendingLabels ||
        pendingAppearance || pendingComposition || pendingCondition || pendingFlowText || pendingFlowAppend || workspaceLifetime === 0}
      onPendingChange={reportSearchPending} onRefresh={refreshSearchMetadata}
      onApply={(expected, search) => {
        const current = history.getState();
        if (!active.current || lifetime.current !== workspaceLifetime || publicationPending.current || current.isSaving || reopening.current || current.isDirty ||
            sourceImportPending.current || labelsPending.current || appearancePending.current || compositionPending.current ||
            conditionPending.current || flowTextPending.current || flowAppendPending.current ||
            canonicalJson(expected) !== canonicalJson(current.source) ||
            (search !== undefined && currentSearchMetadata === null)) return false;
        const candidate = structuredClone(expected);
        if (search === undefined) delete candidate.body.search;
        else candidate.body.search = search;
        const parsed = applicationSourceDocumentV2Schema.safeParse(candidate);
        if (!parsed.success || !history.edit(parsed.data)) return false;
        setSearchMetadata(null); searchRefresh.current += 1;
        setPreparedPublication(null); previewGeneration.current += 1;
        return true;
      }} />
    <ApplicationSourceImport key={sourceImportPanelEpoch}
      disabled={pendingSearch || isPublishing || isReopening || state.isSaving || pendingLabels || pendingAppearance ||
        pendingComposition || pendingCondition || pendingFlowText || pendingFlowAppend || workspaceLifetime === 0}
      readSnapshot={readSourceImportSnapshot}
      onPendingChange={(pending) => reportSourceImportPending(pending, sourceImportPanelEpoch)}
      onApply={(expected, candidate) => {
        if (!sameStudioApplicationSourceImportSnapshot(expected, readSourceImportSnapshot())) return "stale";
        const parsed = applicationSourceDocumentV2Schema.safeParse(candidate);
        if (!parsed.success || parsed.data.key !== expected.key || parsed.data.root_alias !== expected.rootAlias) return "stale";
        const current = history.getState();
        if (canonicalJson(parsed.data) === canonicalJson(current.source)) return "unchanged";
        if (!sameStudioApplicationSourceImportSnapshot(expected, readSourceImportSnapshot())) return "stale";
        if (!history.edit(parsed.data)) return "stale";
        // Reset old inspector buffers only after the one accepted history replacement.
        lifetime.current += 1;
        setWorkspaceLifetime(lifetime.current);
        discardSourceImport();
        setConditionEpoch((value) => value + 1);
        reportConditionPending(false);
        setAppearanceEpoch((value) => value + 1);
        setAppearanceValidationEpoch((value) => value + 1);
        reportAppearancePending(false);
        setCompositionEpoch((value) => value + 1);
        reportCompositionPending(false);
        setFlowEpoch((value) => value + 1);
        reportFlowTextPending(false);
        reportFlowAppendPending(false);
        const currentSelection = selection.getSelection();
        setLabel(currentSelection?.kind === "application" ? parsed.data.body.name
          : currentSelection?.kind === "page"
            ? parsed.data.body.pages.find((page) => page.id === currentSelection.pageAlias)?.name ?? "" : "");
        setDescription(parsed.data.body.description);
        setMessage("Imported source applied to local history. Save explicitly to persist this change.");
        return "applied";
      }} />
    <form aria-label="Application publication" className="space-y-3 rounded border border-border p-4"
      onSubmit={(event) => { event.preventDefault(); void requestPublication("publish"); }}>
      <h2 className="font-semibold">Publish the saved Application</h2>
      <p>Preparation reads the exact saved draft and its published dependencies with your current permissions.
        Confirming recompiles and compares the complete confirmation in a new protected transaction.</p>
      <label className="block space-y-1"><span>Release note</span>
        <textarea className={inputClass} value={publicationNote} maxLength={2000} disabled={isPublishing || pendingSearch || pendingSourceImport}
          onChange={(event) => { if (!publicationPending.current && !sourceImportPending.current && !searchPending.current) setPublicationNote(event.target.value); }} /></label>
      {preparedPublication !== null && <div className="space-y-2">
        <p>Proposed version: {preparedPublication.confirmation.assignedVersion}. Outcome: {preparedPublication.confirmation.outcome}.</p>
        <details open><summary>Complete publication confirmation</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(preparedPublication.confirmation, null, 2)}</pre>
        </details>
      </div>}
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} type="button" disabled={isPublishing || readPublicationSnapshot() === null}
          onClick={() => { void requestPublication("prepare"); }}>Prepare publication</button>
        <button className={buttonClass} type="submit" disabled={isPublishing || preparedPublication === null ||
          publicationNote.trim().length < 1 || !samePublicationSnapshot(preparedPublication.snapshot, readPublicationSnapshot())}
          >Confirm publication</button>
        <button className={buttonClass} type="button" disabled={!isPublishing && preparedPublication === null}
          onClick={cancelPublication}>Cancel confirmation or response</button>
      </div>
      <p role="status" aria-live="polite">{publicationMessage}</p>
      {publishedPublication !== null && <details><summary>Verified publication result</summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(publishedPublication, null, 2)}</pre>
      </details>}
    </form>
    <div className="grid gap-6 lg:grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_minmax(16rem,1fr)]">
      <nav aria-label="Application outline" className="space-y-3"><h2 className="font-semibold">Outline</h2>
        <ul><Outline node={outline} selectedKey={selectionKey} disabled={isPublishing} choose={(node) => {
          if (publicationPending.current || reopening.current || history.getState().isSaving || (((sourceImportPending.current || searchPending.current) || pendingLabels || appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current || conditionPending.current) &&
            !window.confirm("Discard unapplied source import, inspector, appearance, composition, visibility and Flow edits and change selection?"))) return;
          if (!selection.select(node.selection)) return;
          discardSourceImport();
          setConditionEpoch((value) => value + 1);
          reportConditionPending(false);
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
            selection={selected} disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || state.isSaving || pendingLabels || pendingAppearance || pendingFlowText || pendingFlowAppend || pendingCondition || workspaceLifetime === 0}
            onPendingChange={reportCompositionPending} onCommand={(expected, expectedSelection, command) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || pendingLabels || appearancePending.current || flowTextPending.current || flowAppendPending.current ||
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
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || latest.isSaving || conditionPending.current || flowTextPending.current || flowAppendPending.current || latest.source !== current.source ||
                (command.kind === "remove" && (pendingLabels || appearancePending.current || compositionPending.current)) ||
                latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
                latestSelection === null ||
                studioSemanticSelectionKey(latestSelection) !== studioSemanticSelectionKey(expectedSelection) ||
                lifetime.current !== currentContext.localLifetime) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Composition applied to local history. Save to persist it.");
              return "applied";
            }} />}
        {selected?.kind === "placement" && inspector.status === "resolved" &&
          <ApplicationVisibilityConditionEditor key={`${conditionEpoch}:${selectionKey}`} context={compositionContext}
            selection={selected} saved={savedPreviewDraft.current}
            busy={isPublishing || pendingSearch || pendingSourceImport || isReopening || state.isSaving}
            disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || state.isSaving || pendingLabels || pendingAppearance || pendingComposition ||
              pendingFlowText || pendingFlowAppend || workspaceLifetime === 0}
            readSnapshot={readVisibilitySnapshot} onPendingChange={reportConditionPending}
            onCommand={(expected, expectedSelection, metadata, condition, isCurrentResponse) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current ||
                currentSelection?.kind !== "placement" || expectedSelection.kind !== "placement" ||
                currentSelection.placementAlias !== expectedSelection.placementAlias || !isCurrentResponse()) return { kind: "stale" };
              const currentContext: StudioCompositionContext = { organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source };
              const result = applyStudioVisibilityCondition(expected, currentContext, currentSelection, metadata, condition);
              if (result.kind !== "applied") return result;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || latest.isSaving || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current || flowAppendPending.current ||
                latest.source !== current.source || latest.rootId !== current.rootId ||
                latest.draftRevision !== current.draftRevision || lifetime.current !== currentContext.localLifetime ||
                latestSelection?.kind !== "placement" || latestSelection.placementAlias !== currentSelection.placementAlias ||
                !isCurrentResponse()) return { kind: "stale" };
              if (!history.edit(result.source)) return { kind: "invalid", issues: [] };
              setMessage("Visibility condition applied to local history. Save to persist it.");
              return result;
            }} />}
        {selected?.kind === "flow" && inspector.status === "resolved" &&
          <ApplicationFlowEditor key={flowEpoch} context={compositionContext} selection={selected}
            disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || state.isSaving || pendingLabels || pendingAppearance || pendingComposition || pendingCondition || workspaceLifetime === 0}
            onPendingChange={reportFlowTextPending} onAppendPendingChange={reportFlowAppendPending}
            onCommand={(expected, expectedSelection, command) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowAppendPending.current) return "stale";
              const currentContext: StudioFlowTextContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioFlowTextCommand(currentContext, expected, currentSelection, expectedSelection, command);
              if (result.kind !== "applied") return result.kind;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || latest.isSaving || conditionPending.current || labelsPending.current ||
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
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current) return "stale";
              const currentContext: StudioFlowTextContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioFlowPresentationCommand(currentContext, expected, currentSelection, expectedSelection, command);
              if (result.kind !== "applied") return result.kind;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || latest.isSaving || conditionPending.current || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current || latest.source !== current.source ||
                latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
                lifetime.current !== currentContext.localLifetime || latestSelection?.kind !== "flow" ||
                latestSelection.flowAlias !== expectedSelection.flowAlias) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Presentation task appended to local history. Save to persist it.");
              return "applied";
            }} onCalculate={(expected, expectedSelection, command, isCurrentTarget) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowAppendPending.current ||
                !isCurrentTarget()) return "stale";
              const currentContext: StudioFlowTextContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioFlowCalculateCommand(currentContext, expected, currentSelection, expectedSelection, command);
              if (result.kind !== "applied") return result.kind;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || latest.isSaving || conditionPending.current || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowAppendPending.current ||
                !isCurrentTarget() || latest.source !== current.source || latest.rootId !== current.rootId ||
                latest.draftRevision !== current.draftRevision || lifetime.current !== currentContext.localLifetime ||
                latestSelection?.kind !== "flow" || latestSelection.flowAlias !== expectedSelection.flowAlias) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Calculate applied to local history. Save to persist it.");
              return "applied";
            }} onMove={(expected, expectedSelection, command, isCurrentTarget) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || labelsPending.current ||
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
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || latest.isSaving || conditionPending.current || labelsPending.current ||
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
            }} onRemove={(expected, expectedSelection, command, isCurrentTarget) => {
              const current = history.getState();
              const currentSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current ||
                flowAppendPending.current || !isCurrentTarget()) return "stale";
              const currentContext: StudioFlowTextContext = {
                organizationId, rootId: current.rootId, key: draft.key,
                draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source,
              };
              const result = applyStudioFlowPresentationRemovalCommand(currentContext, expected,
                currentSelection, expectedSelection, command);
              if (result.kind !== "applied") return result.kind;
              const latest = history.getState();
              const latestSelection = selection.getSelection();
              if (!active.current || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || latest.isSaving || conditionPending.current || labelsPending.current ||
                appearancePending.current || compositionPending.current || flowTextPending.current ||
                flowAppendPending.current || !isCurrentTarget() || latest.source !== current.source ||
                latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
                lifetime.current !== currentContext.localLifetime || latestSelection?.kind !== "flow" ||
                latestSelection.flowAlias !== expectedSelection.flowAlias) return "stale";
              if (!projectStudioFlowPresentationRemoval(currentContext, expectedSelection,
                command.taskId, command.taskPath)) return "stale";
              if (!history.edit(result.source)) return "invalid";
              setMessage("Show message task removed from local history. Save to persist it.");
              return "applied";
            }} />}
        <p className="text-sm">The outline and inspector select the same authored alias. Other definition content is retained without alteration.</p>
      </section>
      <aside className="space-y-3" aria-label="Selection inspector"><h2 className="font-semibold">Inspector</h2>
        {inspector.status === "resolved" && <p className="break-all text-sm">{inspector.descriptor.kind}: {inspector.descriptor.alias}</p>}
        {editable ? <form className="space-y-3" onSubmit={applyLabels}>
          <label className="block space-y-1"><span>Selected item name</span>
            <input className={inputClass} required maxLength={selected?.kind === "application" ? 120 : 60}
              disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || pendingComposition || pendingFlowText || pendingFlowAppend || pendingCondition} value={label} onChange={(event) => {
                if (publicationPending.current || (sourceImportPending.current || searchPending.current) || conditionPending.current || reopening.current) return;
                labelsPending.current = true;
                previewGeneration.current += 1;
                setLabel(event.target.value);
              }} /></label>
          {selected?.kind === "application" && <label className="block space-y-1"><span>Application description</span>
            <textarea className={inputClass} required maxLength={1000} disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || pendingComposition || pendingFlowText || pendingFlowAppend || pendingCondition}
              value={description} onChange={(event) => {
                if (publicationPending.current || (sourceImportPending.current || searchPending.current) || conditionPending.current || reopening.current) return;
                labelsPending.current = true;
                previewGeneration.current += 1;
                setDescription(event.target.value);
              }} /></label>}
          <button className={buttonClass} disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || pendingAppearance || pendingComposition || pendingFlowText || pendingFlowAppend || pendingCondition} type="submit">Apply labels</button>
          <button className={buttonClass} disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || !pendingLabels} type="button" onClick={() => {
            if (publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current) return;
            setLabel(currentLabel); setDescription(source.body.description);
          }}>Discard inspector text</button>
          <p className="text-sm">Apply records one local history entry. Save persists it through the current protected writer.</p>
        </form> : <p>{selected?.kind === "flow"
          ? "Select a task in the Flow outline to inspect supported presentation text or arithmetic."
          : "This item is read-only in the minimum host."}</p>}
        {selected?.kind === "application" && inspector.status === "resolved" &&
          <ApplicationAppearanceEditor key={appearanceEpoch} organizationId={organizationId}
            rootId={state.rootId} draftRevision={state.draftRevision} source={source}
            validationEpoch={appearanceValidationEpoch}
            disabled={isPublishing || pendingSearch || pendingSourceImport || isReopening || state.isSaving || pendingLabels || pendingComposition || pendingFlowText || pendingFlowAppend || pendingCondition} onPendingChange={reportAppearancePending}
            onApply={(expected, next) => {
              const current = history.getState();
              if (!active.current || lifetime.current !== workspaceLifetime || publicationPending.current || (sourceImportPending.current || searchPending.current) || reopening.current || current.isSaving || conditionPending.current || pendingLabels || compositionPending.current || flowTextPending.current || flowAppendPending.current || current.rootId !== state.rootId ||
                  current.draftRevision !== state.draftRevision || current.source !== state.source ||
                  expected !== source) return false;
              if (publicationPending.current || (sourceImportPending.current || searchPending.current) || conditionPending.current) return false;
              const applied = history.edit(next);
              if (applied) setMessage("Appearance applied to local history. Save to persist it.");
              return applied;
            }} />}
      </aside>
    </div>
    <ApplicationDraftPreview context={readPreviewContext()} readContext={readPreviewContext} />
  </main>;
}
