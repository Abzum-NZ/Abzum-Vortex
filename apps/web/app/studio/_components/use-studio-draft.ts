"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applicationSourceDocumentSchema, canonicalJson, describeFailure,
  type ApplicationSourceDocument, type ImmutablePlatformBlockCatalogue, type PeopleDirectoryOwner,
} from "@vortex/platform/schema";
import {
  createStudioApplicationDraftHistoryController, createStudioSemanticSelectionStore,
  type StudioApplicationDraftHistoryController, type StudioApplicationDraftHistoryState, type StudioBorrowedChoices,
  type StudioCompileFailure, type StudioSemanticSelection, type StudioSemanticSelectionStore, type StudioStoredApplicationDraft,
} from "@vortex/ui/studio";
import { saveStudioApplication, type StudioDraftChangedElsewhere } from "../actions";
import { useStudioPreview, type StudioPreviewReadiness } from "./use-studio-preview";
import { reopenStudioApplication } from "../_lib/studio-read-client";
import type { StudioApplicationCanvasFrames, StudioApplicationCompiledPageSlots } from "../../_lib/studio-application-draft";
import type { StudioCompiledFields, StudioDataModule, StudioPublishedData } from "../_lib/studio-data-model";
import { summarizeSourceChange, type SourceChangeRow } from "../_lib/source-change-summary";
import { conflictMessage, refusalMessage } from "./studio-refusal-messages";
import { useStudioSession } from "./use-studio-session";

/** How long Studio waits after the last edit of a batch before it saves the batch. */
const autosaveDelayMs = 600;
/** How long Studio waits before it tries again a save the platform did not confirm, doubling each time. */
const retryDelayMs = 4000;
/** After this many unconfirmed saves in a row, Studio waits for the next edit instead of trying again. */
const maximumRetries = 5;

/**
 * What the canvas and the Data tab draw from: the compile of one saved revision, with what the
 * platform read alongside it. The canvas reads records only for this revision.
 */
export type StudioCompiledView = Readonly<{
  source: StudioStoredApplicationDraft["source"];
  draftRevision: number;
  sourceFingerprint: string;
  slots: StudioApplicationCompiledPageSlots | null;
  frames: StudioApplicationCanvasFrames | null;
  failure: StudioCompileFailure | null;
  /** Counts compiles taken, so views of the saved draft know to read again. */
  generation: number;
  compiledFields: StudioCompiledFields | null;
  borrowedChoices: StudioBorrowedChoices | null;
  usedModules: readonly StudioDataModule[] | null;
  published: StudioPublishedData | null;
  peopleDirectory: PeopleDirectoryOwner | null;
}>;

/** Where the draft stands against the saved draft, for the one status chip and what blocks edits. */
export type StudioSaveStatus =
  | Readonly<{ kind: "saved" }>
  | Readonly<{ kind: "saving" }>
  /** Another window or person saved a newer revision: edits stop until the latest draft is loaded. */
  | Readonly<{ kind: "conflict"; message: string; changedBy: string | null; changedAt: string | null;
      changes: readonly SourceChangeRow[] }>
  /** The platform refused the batch; the next edit (an Undo, say) tries again. */
  | Readonly<{ kind: "refused"; message: string; reason?: string | undefined }>
  /** The platform did not confirm the save; Studio tries again by itself. */
  | Readonly<{ kind: "failed"; message: string }>;

/** What one command did to the draft: changed it (one history entry) or kept it as it is. */
export type StudioDraftStep<Result> =
  | Readonly<{ kind: "edit"; source: ApplicationSourceDocument; result: Result }>
  | Readonly<{ kind: "keep"; result: Result }>;

/** The envelope's answer: the command ran (and `changed` says whether the draft took an edit), or it could not run now. */
export type StudioRunOutcome<Result> =
  | Readonly<{ kind: "done"; result: Result; changed: boolean }>
  | Readonly<{ kind: "blocked"; message: string }>;

export type StudioRunOptions = Readonly<{
  /** The source the caller's view was drawn from; any other current source makes the command stale. */
  expected?: unknown | undefined;
  /** Consecutive edits with this key (typing into one field) are one Undo step. */
  merge?: string | undefined;
}>;

/** A request that holds the whole draft while it runs: nothing else may edit it meanwhile. */
export type StudioDraftHold = "publication" | "reopening" | "restoring";

/**
 * The one draft of a Studio workspace: its history (Undo and Redo), its one selection store, the
 * autosave of each batch of edits with optimistic concurrency, and the compile the canvas draws.
 * Every tab edits the draft through `run`, the single command envelope.
 */
export type StudioDraft = Readonly<{
  session: ReturnType<typeof useStudioSession>;
  organizationId: string;
  history: StudioApplicationDraftHistoryController;
  selection: StudioSemanticSelectionStore;
  state: StudioApplicationDraftHistoryState;
  /** The current source, parsed once per history entry. */
  source: ApplicationSourceDocument;
  selected: StudioSemanticSelection | null;
  /** The saved draft the current history extends. */
  saved: StudioStoredApplicationDraft;
  preview: StudioPreviewReadiness;
  /**
   * Live: the saved draft at this moment, for requests that run before the next render (a flush
   * followed by Publish, Preview or an agent call). It changes once per saved edit batch.
   */
  readSaved: () => StudioStoredApplicationDraft;
  view: StudioCompiledView;
  /** The canvas draws an older revision than the saved one (or the draft is not saved yet). */
  updatingCanvas: boolean;
  status: StudioSaveStatus;
  /** The status chip: "Saved", "Saving…", "Not saved", with "Updating canvas…" while the canvas catches up. */
  chip: string;
  /** Changes when the history is replaced (a reload), so contexts built for the old history go stale. */
  lifetime: number;
  /** Rendered: a hold is on, the draft is in conflict or not mounted yet, so the controls that edit it are disabled. */
  locked: boolean;
  isHeld: (hold: StudioDraftHold) => boolean;
  hold: (hold: StudioDraftHold, on: boolean) => void;
  /** Live: why an edit cannot run now, or undefined. */
  blockedReason: () => string | undefined;
  /** The parsed source for a history snapshot, the same object each time it is asked for. */
  parsed: (source: StudioApplicationDraftHistoryState["source"]) => ApplicationSourceDocument;
  run: <Result>(command: (source: ApplicationSourceDocument) => StudioDraftStep<Result>, options?: StudioRunOptions) =>
    StudioRunOutcome<Result>;
  select: (next: StudioSemanticSelection | null) => boolean;
  undo: () => void;
  redo: () => void;
  /** Saves what is waiting now and answers whether the draft on screen is the saved draft. */
  flush: () => Promise<boolean>;
  /** A user-requested retry of a refused save, preserving the current history and expected revision. */
  retry: () => Promise<void>;
  /** Loads the latest saved draft into a new history (after a conflict, a restore or a page adoption). */
  reload: () => Promise<boolean>;
  isActive: () => boolean;
}>;

class StudioSaveError extends Error {
  constructor(readonly code: string, readonly reason?: string) {
    super(code);
    this.name = "StudioSaveError";
  }
}

type LoadedResult = Extract<Awaited<ReturnType<typeof reopenStudioApplication>>, { kind: "available" }>;
/**
 * The view of a new compile. What was read alongside an earlier compile (the modules used, what is
 * published, borrowed choices, the people directory) is kept when this read did not return it, so a
 * draft that does not compile for a moment never makes saved fields look published.
 */
const viewOf = (result: LoadedResult, generation: number, previous: StudioCompiledView): StudioCompiledView => ({
  source: result.draft.source, draftRevision: result.draft.draftRevision, sourceFingerprint: result.draft.sourceFingerprint,
  slots: result.pageCompiledSlots, frames: result.canvasFrames, failure: result.compileFailure, generation,
  compiledFields: result.compiledFields, borrowedChoices: result.borrowedChoices ?? previous.borrowedChoices,
  usedModules: result.usedModules ?? previous.usedModules, published: result.published ?? previous.published,
  peopleDirectory: result.peopleDirectory ?? previous.peopleDirectory,
});

const personWords = (label: StudioDraftChangedElsewhere["changedBy"]): string | null =>
  label.kind === "named" ? label.name : label.kind === "restricted" ? "Someone outside your directory" : null;

/** The Studio draft store. Created once per workspace; its history and selection live as long as the page. */
export function useStudioDraft({ organizationId, draft, catalogue, initialView }: Readonly<{
  organizationId: string;
  draft: StudioStoredApplicationDraft;
  catalogue: ImmutablePlatformBlockCatalogue;
  initialView: Omit<StudioCompiledView, "source" | "draftRevision" | "sourceFingerprint" | "generation">;
}>): StudioDraft {
  const session = useStudioSession();
  const active = useRef(false);
  const savedRef = useRef(draft);
  // The draft a save returned, taken as saved only once the history accepts it.
  const returned = useRef<StudioStoredApplicationDraft | null>(null);
  const readReturned = () => returned.current;
  const retries = useRef(0);
  const elsewhere = useRef<StudioDraftChangedElsewhere | null>(null);
  const readElsewhere = () => elsewhere.current;
  const holds = useRef(new Set<StudioDraftHold>());
  const [renderedHolds, setRenderedHolds] = useState<ReadonlySet<StudioDraftHold>>(() => new Set());
  const statusRef = useRef<StudioSaveStatus>({ kind: "saved" });
  const [status, setStatusState] = useState<StudioSaveStatus>({ kind: "saved" });
  const setStatus = (next: StudioSaveStatus) => { statusRef.current = next; setStatusState(next); };
  const parsedCache = useRef(new WeakMap<object, ApplicationSourceDocument>());
  const parsed = useCallback((source: StudioApplicationDraftHistoryState["source"]): ApplicationSourceDocument => {
    const known = parsedCache.current.get(source);
    if (known !== undefined) return known;
    const next = applicationSourceDocumentSchema.parse(source);
    parsedCache.current.set(source, next);
    return next;
  }, []);

  const [history] = useState(() => createStudioApplicationDraftHistoryController(draft, {
    saveDraft: async (command) => {
      const result = await session.save(() => saveStudioApplication(organizationId, command));
      // A save sent as the workspace closes (leaving Studio within a batch) still completes on the server.
      if (result.kind === "available") { returned.current = result.draft; return result.draft; }
      if (!active.current) throw new StudioSaveError("STUDIO_WORKSPACE_CLOSED");
      if (result.kind === "conflict") elsewhere.current = "elsewhere" in result ? result.elsewhere : null;
      throw new StudioSaveError(result.kind === "conflict"
        ? "DEFINITION_DRAFT_STALE_OR_MISSING"
        : result.kind === "refused" ? "DEFINITION_CONTEXT_REFUSED" : "STUDIO_SAVE_FAILED",
      result.kind === "conflict" || result.kind === "refused" ? result.reason : undefined);
    },
  }));
  const [selection] = useState(() => createStudioSemanticSelectionStore({ rootId: draft.rootId, source: draft.source, catalogue }));
  const [state, setState] = useState(() => history.getState());
  const [selected, setSelected] = useState(() => selection.getSelection());
  const [saved, setSaved] = useState(draft);
  const preview = useStudioPreview(organizationId, saved);
  const [view, setView] = useState<StudioCompiledView>(() => ({ ...initialView, source: draft.source,
    draftRevision: draft.draftRevision, sourceFingerprint: draft.sourceFingerprint, generation: 0 }));
  const [lifetime, setLifetime] = useState(0);
  const lifetimeRef = useRef(0);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const compiling = useRef<Promise<void> | null>(null);
  const compileAgain = useRef(false);
  const generation = useRef(0);

  // The compile of the saved head, asked for only once no edit is waiting, so a batch costs one save and one compile.
  const refreshCompiled = useCallback(async (): Promise<void> => {
    if (compiling.current !== null) { compileAgain.current = true; return compiling.current; }
    const run = (async () => {
      do {
        compileAgain.current = false;
        const target = savedRef.current;
        try {
          const result = await reopenStudioApplication(organizationId, target.rootId);
          if (!active.current) return;
          if (result.kind !== "available" || result.organizationId !== organizationId ||
            result.draft.draftRevision !== savedRef.current.draftRevision ||
            result.draft.sourceFingerprint !== savedRef.current.sourceFingerprint) {
            if (result.kind === "available" && result.draft.draftRevision > savedRef.current.draftRevision &&
              statusRef.current.kind !== "conflict") {
              // Another window or person saved since: say so now rather than at the next edit.
              setStatus({ kind: "conflict", changedBy: null, changedAt: result.draft.updatedAt,
                changes: summarizeSourceChange(applicationSourceDocumentSchema.parse(savedRef.current.source),
                  applicationSourceDocumentSchema.parse(result.draft.source)),
                message: "A newer version of this draft was saved in another window or by someone else." });
              return;
            }
            if (result.kind !== "available" || result.draft.draftRevision < savedRef.current.draftRevision)
              console.error(`[studio] the saved draft's compile did not answer for revision ${savedRef.current.draftRevision}: STUDIO_COMPILE_REFRESH_${result.kind.toUpperCase()}`);
            continue;
          }
          generation.current += 1;
          setView((previous) => viewOf(result, generation.current, previous));
        } catch (error) {
          console.error("[studio] compiling the saved draft for the canvas failed", describeFailure(error));
        }
      } while (compileAgain.current && active.current);
    })();
    compiling.current = run;
    try { await run; } finally { compiling.current = null; }
  }, [organizationId]);

  const scheduleSave = useCallback((delay: number) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveNow(); }, delay);
  }, []);

  // One save of the newest entry; edits made while it runs are saved by the next one.
  const saveNow = useCallback(async (): Promise<void> => {
    clearTimeout(saveTimer.current);
    if (saving.current !== null) return saving.current;
    const before = history.getState();
    if (!active.current || !before.isDirty || holds.current.has("reopening") || statusRef.current.kind === "conflict") return;
    const run = (async () => {
      elsewhere.current = null;
      returned.current = null;
      const outcome = await history.save();
      if (!active.current) return;
      const after = history.getState();
      if (outcome.kind !== "failed") retries.current = 0;
      switch (outcome.kind) {
        case "saved": {
          const accepted = readReturned();
          if (accepted !== null) savedRef.current = accepted;
          setSaved(savedRef.current);
          setStatus(after.isDirty ? { kind: "saving" } : { kind: "saved" });
          if (after.isDirty) scheduleSave(autosaveDelayMs);
          else void refreshCompiled();
          return;
        }
        case "conflict": {
          if (outcome.reason === "alias_conflict") {
            setStatus({ kind: "refused", message: conflictMessage(outcome.reason,
              "Your edit is kept. Undo the import or correct the component names, and Studio saves again.") });
            return;
          }
          // Read through a function: TypeScript would otherwise narrow the ref to the null assigned before the awaited save.
          const latest = readElsewhere();
          if (outcome.reason !== "draft_changed" || latest === null) {
            setStatus({ kind: "conflict", changedBy: null, changedAt: null, changes: [],
              message: conflictMessage(outcome.reason, "Your latest change was not saved.") });
            return;
          }
          const changes = summarizeSourceChange(applicationSourceDocumentSchema.parse(savedRef.current.source),
            applicationSourceDocumentSchema.parse(latest.draft.source));
          const who = personWords(latest.changedBy);
          setStatus({ kind: "conflict", changedBy: who, changedAt: latest.draft.updatedAt, changes,
            message: `${who ?? "Someone"} saved a newer version of this draft, so your latest change was not saved.` });
          return;
        }
        case "refused":
          setStatus({ kind: "refused", reason: outcome.reason, message: refusalMessage(outcome.reason, "Your latest change was not saved; Undo it or change it, and Studio saves again.") });
          // An edit made while the refused save ran is a new attempt.
          if (after.isDirty && after.source !== before.source) scheduleSave(autosaveDelayMs);
          return;
        case "failed":
          retries.current += 1;
          if (retries.current > maximumRetries) {
            setStatus({ kind: "refused", message: "The platform did not confirm several saves in a row. Your changes are kept on screen; Studio tries again with your next edit." });
            return;
          }
          setStatus({ kind: "failed", message: "The platform did not confirm the save. Studio tries again in a moment; your changes are kept." });
          scheduleSave(retryDelayMs * 2 ** (retries.current - 1));
          return;
        case "busy":
          scheduleSave(autosaveDelayMs);
          return;
      }
    })();
    saving.current = run;
    try { await run; } finally { saving.current = null; }
  }, [history, refreshCompiled, scheduleSave]);

  useEffect(() => {
    active.current = true;
    lifetimeRef.current += 1;
    setLifetime(lifetimeRef.current);
    const unsubscribeHistory = history.subscribe((next) => {
      selection.reconcile({ rootId: next.rootId, source: parsed(next.source), catalogue });
      setState(next);
      if (next.isSaving) return;
      // An edit after a refusal or a failure is a new attempt; a conflict waits for the latest draft.
      if (next.isDirty && statusRef.current.kind !== "conflict") {
        if (statusRef.current.kind !== "saving") setStatus({ kind: "saving" });
        if (saving.current === null) scheduleSave(autosaveDelayMs);
      } else if (!next.isDirty && statusRef.current.kind !== "saved" && statusRef.current.kind !== "conflict") setStatus({ kind: "saved" });
    });
    const unsubscribeSelection = selection.subscribe(setSelected);
    return () => {
      clearTimeout(saveTimer.current);
      const pending = history.getState();
      if (pending.isDirty && !pending.isSaving && statusRef.current.kind !== "conflict") void history.save();
      active.current = false;
      lifetimeRef.current += 1;
      unsubscribeHistory();
      unsubscribeSelection();
    };
  }, [history, selection, catalogue, parsed, scheduleSave]);

  // Leaving the page while a batch is waiting to be saved is confirmed by the browser.
  const unsaved = state.isDirty || state.isSaving;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const hold = useCallback((key: StudioDraftHold, on: boolean) => {
    if (holds.current.has(key) === on) return;
    if (on) holds.current.add(key); else holds.current.delete(key);
    setRenderedHolds(new Set(holds.current));
  }, []);

  const blockedReason = useCallback((): string | undefined => {
    if (!active.current) return "The workspace is closing.";
    if (holds.current.has("reopening")) return "The saved draft is loading. Try again in a moment.";
    if (holds.current.has("publication")) return "The draft is being published. Try again when it finishes.";
    if (holds.current.has("restoring")) return "A published version is being restored into the draft. Try again when it finishes.";
    if (statusRef.current.kind === "conflict") return "This draft was changed elsewhere. Load the latest draft before you change it.";
    return undefined;
  }, []);

  const run = useCallback(<Result,>(command: (source: ApplicationSourceDocument) => StudioDraftStep<Result>,
    options: StudioRunOptions = {}): StudioRunOutcome<Result> => {
    const blocked = blockedReason();
    if (blocked !== undefined) return { kind: "blocked", message: blocked };
    const current = history.getState();
    const currentSource = parsed(current.source);
    const stale = { kind: "blocked", message: "The draft changed while this was being checked, so nothing was changed. Try again." } as const;
    if (options.expected !== undefined && options.expected !== current.source && options.expected !== currentSource) return stale;
    const step = command(currentSource);
    if (step.kind === "keep") return { kind: "done", result: step.result, changed: false };
    if (history.getState().source !== current.source) return stale;
    if (history.edit(step.source, options.merge)) return { kind: "done", result: step.result, changed: true };
    if (canonicalJson(step.source) === canonicalJson(currentSource)) return { kind: "done", result: step.result, changed: false };
    console.error("[studio] the draft history refused a command's source: STUDIO_DRAFT_EDIT_REFUSED");
    return { kind: "blocked", message: "The draft did not accept this change, so nothing was changed." };
  }, [blockedReason, history, parsed]);

  const flush = useCallback(async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (saving.current !== null) await saving.current;
      const current = history.getState();
      if (!active.current || statusRef.current.kind === "conflict" || statusRef.current.kind === "refused") return false;
      if (!current.isDirty) return true;
      await saveNow();
    }
    return !history.getState().isDirty;
  }, [history, saveNow]);

  const reload = useCallback(async (): Promise<boolean> => {
    if (holds.current.has("reopening")) return false;
    hold("reopening", true);
    clearTimeout(saveTimer.current);
    try {
      if (saving.current !== null) await saving.current;
      const result = await reopenStudioApplication(organizationId, draft.rootId);
      if (!active.current) return false;
      if (result.kind !== "available" || result.organizationId !== draft.organizationId || !history.reopen(result.draft)) {
        console.error(`[studio] the latest saved draft could not be loaded: STUDIO_RELOAD_${result.kind.toUpperCase()}`);
        return false;
      }
      savedRef.current = result.draft;
      setSaved(result.draft);
      generation.current += 1;
      setView((previous) => viewOf(result, generation.current, previous));
      lifetimeRef.current += 1;
      setLifetime(lifetimeRef.current);
      setStatus({ kind: "saved" });
      return true;
    } catch (error) {
      console.error("[studio] loading the latest saved draft failed", describeFailure(error));
      return false;
    } finally {
      hold("reopening", false);
    }
  }, [organizationId, draft.rootId, draft.organizationId, history, hold]);

  const source = parsed(state.source);
  const retry = useCallback(async () => {
    if (!active.current || !history.getState().isDirty || blockedReason() !== undefined) return;
    retries.current = 0;
    setStatus({ kind: "saving" });
    await saveNow();
  }, [history, blockedReason, saveNow]);
  const updatingCanvas = view.draftRevision !== saved.draftRevision || state.isDirty;
  const words = status.kind === "saved" ? "Saved" : status.kind === "saving" ? "Saving…" : "Not saved";
  const chip = status.kind === "conflict" || status.kind === "refused" ? words
    : updatingCanvas ? `${words} · Updating canvas…` : words;
  const locked = renderedHolds.size > 0 || status.kind === "conflict" || lifetime === 0;

  return useMemo<StudioDraft>(() => ({
    session, organizationId, history, selection, state, source, selected, saved, preview, readSaved: () => savedRef.current, view, updatingCanvas, status, chip, lifetime, locked,
    isHeld: (key) => renderedHolds.has(key), hold, blockedReason, parsed, run,
    select: (next) => selection.select(next),
    undo: () => { if (blockedReason() === undefined) history.undo(); },
    redo: () => { if (blockedReason() === undefined) history.redo(); },
    flush, retry, reload, isActive: () => active.current,
  }), [session, organizationId, history, selection, state, source, selected, saved, preview, view, updatingCanvas, status, chip, lifetime, locked,
    renderedHolds, hold, blockedReason, parsed, run, flush, retry, reload]);
}
