"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  describeFailure,
  type ApplicationSourceDocument,
  type PeopleDirectoryOwner,
  type SourceIdentityReservation,
} from "@vortex/platform/schema";
import {
  createStudioApplicationDraftHistoryController,
  createStudioSemanticSelectionStore,
  type StudioApplicationDraftHistoryController,
  type StudioApplicationDraftHistoryState,
  type StudioBorrowedChoices,
  type StudioCompileFailure,
  type StudioSemanticSelection,
  type StudioSemanticSelectionStore,
  type StudioStoredApplicationDraft,
} from "@vortex/ui/studio";
import { saveStudioApplication, type StudioDraftChangedElsewhere } from "../actions";
import { reopenStudioApplication } from "../_lib/studio-reads";
import { createStudioPreviewGate, type StudioPreviewGate } from "../_lib/studio-preview-gate";
import type {
  StudioViewResources,
  StudioApplicationCanvasFrames,
  StudioApplicationCompiledPageSlots,
  StudioFlowPlacements,
} from "../../_lib/studio-application-draft";
import type {
  StudioCompiledFields,
  StudioDataModule,
  StudioPublishedData,
} from "../_lib/studio-data-model";
import { studioViewRequest, type StudioViewRequest } from "../_lib/studio-view-request";
import { summarizeSourceChange, type SourceChangeRow } from "../_lib/source-change-summary";
import { conflictMessage, refusalMessage } from "./studio-refusal-messages";
import { useLeaveWarning } from "./use-leave-warning";
import { useStudioSession } from "./use-studio-session";

/** How long Studio waits after the last edit of a batch before it saves the batch. */
const autosaveDelayMs = 300;
/** How long Studio waits before it tries again a save the platform did not confirm, doubling each time. */
const retryDelayMs = 4000;
/** After this many unconfirmed saves in a row, Studio waits for the next edit instead of trying again. */
const maximumRetries = 5;

/**
 * What the canvas and the Data tab draw from: the compile of one saved revision, with what the
 * platform read alongside it. The canvas reads records only for this revision.
 */
type StudioCompiledView = StudioViewResources &
  Readonly<{
    catalogue: StudioCatalogue;
    source: StudioStoredApplicationDraft["source"];
    draftRevision: number;
    sourceFingerprint: string;
    /** The revision's data shape: its records are read once the builder's preview runs it. */
    previewShape: string;
    slots: StudioApplicationCompiledPageSlots | null;
    frames: StudioApplicationCanvasFrames | null;
    flowPlacements: StudioFlowPlacements | null;
    failure: StudioCompileFailure | null;
    /** Counts compiles taken, so views of the saved draft know to read again. */
    generation: number;
    compiledFields: StudioCompiledFields | null;
    borrowedChoices: StudioBorrowedChoices | null;
    usedModules: readonly StudioDataModule[] | null;
    published: StudioPublishedData | null;
    peopleDirectory: PeopleDirectoryOwner | null;
    identityReservations: readonly SourceIdentityReservation[] | null;
  }>;

/** Where the draft stands against the saved draft, for the one status chip and what blocks edits. */
type StudioSaveStatus =
  | Readonly<{ kind: "saved" }>
  | Readonly<{ kind: "saving" }>
  /** Another window or person saved a newer revision: edits stop until the latest draft is loaded. */
  | Readonly<{
      kind: "conflict";
      message: string;
      changedBy: string | null;
      changedAt: string | null;
      changes: readonly SourceChangeRow[];
    }>
  /** The platform refused the batch; the next edit (an Undo, say) tries again. */
  | Readonly<{ kind: "refused"; message: string; reason?: string | undefined }>
  /** The platform did not confirm the save; Studio tries again by itself. */
  | Readonly<{ kind: "failed"; message: string }>;

/** What one command did to the draft: changed it (one history entry) or kept it as it is. */
export type StudioDraftStep<Result> =
  | Readonly<{
      kind: "edit";
      source: ApplicationSourceDocument;
      result: Result;
    }>
  | Readonly<{ kind: "keep"; result: Result }>;

/** The envelope's answer: the command ran (and `changed` says whether the draft took an edit), or it could not run now. */
type StudioRunOutcome<Result> =
  | Readonly<{ kind: "done"; result: Result; changed: boolean }>
  | Readonly<{ kind: "blocked"; message: string }>;

export type StudioRunOptions = Readonly<{
  /** The source the caller's view was drawn from; any other current source makes the command stale. */
  expected?: unknown | undefined;
  /** Consecutive edits with this key (typing into one field) are one Undo step. */
  merge?: string | undefined;
}>;

/** A request that holds the whole draft while it runs: nothing else may edit it meanwhile. */
type StudioDraftHold = "publication" | "reopening" | "restoring";

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
  /**
   * Live: the saved draft at this moment, for requests that run before the next render (a flush
   * followed by Publish, Preview or an agent call). It changes once per saved edit batch.
   */
  readSaved: () => StudioStoredApplicationDraft;
  view: StudioCompiledView;
  /** When the builder's preview runs a compiled revision's data shape, for every reader of its records. */
  preview: StudioPreviewGate;
  /** Live immutable resources, including an agent read completed before the next render. */
  readCatalogue: () => StudioCompiledView["catalogue"];
  loadingView: boolean;
  viewProblem: string;
  refreshView: () => Promise<void>;
  /** Resources for an invoked agent tool, read at the saved revision through the same view loader. */
  loadAuthoringResources: () => Promise<Pick<
    StudioCompiledView,
    "catalogue" | "borrowedChoices"
  > | null>;
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
  run: <Result>(
    command: (source: ApplicationSourceDocument) => StudioDraftStep<Result>,
    options?: StudioRunOptions,
  ) => StudioRunOutcome<Result>;
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
  constructor(
    readonly code: string,
    readonly reason?: string,
    readonly sentence?: string,
  ) {
    super(code);
    this.name = "StudioSaveError";
  }
}

type LoadedResult = Extract<
  Awaited<ReturnType<typeof reopenStudioApplication>>,
  { kind: "available" }
>;
type StudioCatalogue = LoadedResult["catalogue"];
/** One view a read returned, with the catalogue that read sent once for all its views. */
type LoadedView = LoadedResult["views"][number] & Readonly<{ catalogue: StudioCatalogue }>;
/** Views read for one saved revision, by request key; a newer saved revision replaces them all. */
type StudioViewCache = Readonly<{
  draftRevision: number;
  sourceFingerprint: string;
  draft: LoadedResult["draft"];
  previewShape: string;
  views: Map<string, LoadedView>;
}>;

/** Revision-bound metadata is replaced; immutable editor resources remain for this visit. */
const viewOf = (
  { draft, previewShape }: Pick<LoadedResult, "draft" | "previewShape">,
  loaded: LoadedView,
  generation: number,
  previous: StudioCompiledView,
): StudioCompiledView => ({
  request: loaded.request,
  catalogue: loaded.catalogue.releases.length === 0 ? previous.catalogue : loaded.catalogue,
  themeOptions: loaded.themeOptions ?? previous.themeOptions,
  fieldInputControlReleases: loaded.fieldInputControlReleases ?? previous.fieldInputControlReleases,
  platformThemeTokens: loaded.platformThemeTokens,
  source: draft.source,
  draftRevision: draft.draftRevision,
  sourceFingerprint: draft.sourceFingerprint,
  previewShape,
  slots: loaded.pageCompiledSlots,
  frames: loaded.canvasFrames,
  flowPlacements: loaded.flowPlacements,
  failure: loaded.compileFailure,
  generation,
  compiledFields: loaded.compiledFields,
  borrowedChoices: loaded.borrowedChoices,
  usedModules: loaded.usedModules,
  published: loaded.published,
  peopleDirectory: loaded.peopleDirectory,
  identityReservations: loaded.identityReservations,
});

const personWords = (label: StudioDraftChangedElsewhere["changedBy"]): string | null =>
  label.kind === "named"
    ? label.name
    : label.kind === "restricted"
      ? "Someone outside your directory"
      : null;

/** The Studio draft store. Created once per workspace; its history and selection live as long as the page. */
export function useStudioDraft({
  organizationId,
  draft,
  tab,
  creation,
  initialView,
}: Readonly<{
  organizationId: string;
  draft: StudioStoredApplicationDraft;
  tab: string;
  creation: StudioViewRequest["creation"];
  initialView: Omit<
    StudioCompiledView,
    "source" | "draftRevision" | "sourceFingerprint" | "generation"
  >;
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
  const [status, setStatusState] = useState<StudioSaveStatus>({
    kind: "saved",
  });
  const setStatus = (next: StudioSaveStatus) => {
    statusRef.current = next;
    setStatusState(next);
  };
  const parsedCache = useRef(new WeakMap<object, ApplicationSourceDocument>());
  const parsed = useCallback(
    (source: StudioApplicationDraftHistoryState["source"]): ApplicationSourceDocument => {
      const known = parsedCache.current.get(source);
      if (known !== undefined) return known;
      const next = applicationSourceDocumentSchema.parse(source);
      parsedCache.current.set(source, next);
      return next;
    },
    [],
  );

  const [history] = useState(() =>
    createStudioApplicationDraftHistoryController(draft, {
      saveDraft: async (command) => {
        const result = await session.save(() => saveStudioApplication(organizationId, command));
        // A save sent as the workspace closes (leaving Studio within a batch) still completes on the server.
        if (result.kind === "available") {
          returned.current = result.draft;
          return result.draft;
        }
        if (!active.current) throw new StudioSaveError("STUDIO_WORKSPACE_CLOSED");
        if (result.kind === "conflict")
          elsewhere.current = "elsewhere" in result ? result.elsewhere : null;
        throw new StudioSaveError(
          result.kind === "conflict"
            ? "DEFINITION_DRAFT_STALE_OR_MISSING"
            : result.kind === "refused"
              ? "DEFINITION_CONTEXT_REFUSED"
              : "STUDIO_SAVE_FAILED",
          result.kind === "conflict" || result.kind === "refused" ? result.reason : undefined,
          result.kind === "refused" ? result.sentence : undefined,
        );
      },
    }),
  );
  const [preview] = useState(() => createStudioPreviewGate(organizationId, draft.rootId));
  const [selection] = useState(() =>
    createStudioSemanticSelectionStore({
      rootId: draft.rootId,
      source: draft.source,
      catalogue: initialView.catalogue,
    }),
  );
  const [state, setState] = useState(() => history.getState());
  const [selected, setSelected] = useState(() => selection.getSelection());
  const [saved, setSaved] = useState(draft);
  const [view, setView] = useState<StudioCompiledView>(() => ({
    ...initialView,
    source: draft.source,
    draftRevision: draft.draftRevision,
    sourceFingerprint: draft.sourceFingerprint,
    generation: 0,
  }));
  const request: StudioViewRequest = {
    ...studioViewRequest(tab, selected, parsed(state.source)),
    ...(tab === "structure" && creation !== undefined ? { creation } : {}),
  };
  const requestKey = JSON.stringify(request);
  const requestRef = useRef({ request, key: requestKey });
  requestRef.current = { request, key: requestKey };
  const catalogue = view.catalogue;
  const catalogueRef = useRef(catalogue);
  catalogueRef.current = catalogue;
  const [viewProblem, setViewProblem] = useState("");
  const [lifetime, setLifetime] = useState(0);
  const lifetimeRef = useRef(0);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const compiling = useRef<Promise<void> | null>(null);
  const compileAgain = useRef(false);
  const generation = useRef(0);
  // The view the page opened with is the first one known for the saved revision.
  const viewCache = useRef<StudioViewCache | null>(null);
  if (viewCache.current === null)
    viewCache.current = {
      draftRevision: draft.draftRevision,
      sourceFingerprint: draft.sourceFingerprint,
      draft,
      previewShape: initialView.previewShape,
      views: new Map([
        [
          JSON.stringify(initialView.request),
          {
            request: initialView.request,
            catalogue: initialView.catalogue,
            themeOptions: initialView.themeOptions,
            fieldInputControlReleases: initialView.fieldInputControlReleases,
            platformThemeTokens: initialView.platformThemeTokens,
            compiledFields: initialView.compiledFields,
            borrowedChoices: initialView.borrowedChoices,
            usedModules: initialView.usedModules,
            published: initialView.published,
            peopleDirectory: initialView.peopleDirectory,
            identityReservations: initialView.identityReservations,
            pageCompiledSlots: initialView.slots,
            canvasFrames: initialView.frames,
            flowPlacements: initialView.flowPlacements,
            compileFailure: initialView.failure,
          },
        ],
      ]),
    };

  /** Keeps every view a read returned for the saved revision it was read at. */
  const remember = useCallback(
    (
      result: LoadedResult,
      requested: readonly Readonly<{
        request: StudioViewRequest;
        key: string;
      }>[],
    ) => {
      const { draftRevision, sourceFingerprint } = result.draft;
      const known = viewCache.current;
      const views =
        known !== null &&
        known.draftRevision === draftRevision &&
        known.sourceFingerprint === sourceFingerprint
          ? known.views
          : new Map<string, LoadedView>();
      requested.forEach(({ request, key }, index) => {
        const loaded = result.views[index];
        // Kept under the request as it was sent, so a drawn view always matches its key.
        if (loaded !== undefined)
          views.set(key, { ...loaded, request, catalogue: result.catalogue });
      });
      viewCache.current = {
        draftRevision,
        sourceFingerprint,
        draft: result.draft,
        previewShape: result.previewShape,
        views,
      };
    },
    [],
  );

  /** The view already read for this key at the saved revision, if there is one. */
  const knownView = useCallback((key: string) => {
    const known = viewCache.current;
    const target = savedRef.current;
    const loaded = known?.views.get(key);
    return known === null ||
      loaded === undefined ||
      known.draftRevision !== target.draftRevision ||
      known.sourceFingerprint !== target.sourceFingerprint
      ? undefined
      : { draft: known.draft, previewShape: known.previewShape, loaded };
  }, []);

  /** Draws the visible view from a read already made for the saved revision, if there is one. */
  const adoptKnown = useCallback(
    (key: string): boolean => {
      const known = knownView(key);
      if (known === undefined) return false;
      generation.current += 1;
      setView((previous) => viewOf(known, known.loaded, generation.current, previous));
      return true;
    },
    [knownView],
  );
  // A switch to a view already read is drawn in this same render, so it costs no extra commit.
  const switchedTo =
    JSON.stringify(view.request) !== requestKey && !state.isDirty && !state.isSaving
      ? knownView(requestKey)
      : undefined;
  if (switchedTo !== undefined)
    setView((previous) => viewOf(switchedTo, switchedTo.loaded, previous.generation + 1, previous));

  // The compile of the saved head, asked for only once no edit is waiting, so a batch costs one save and one compile.
  const refreshCompiled = useCallback(async (): Promise<void> => {
    if (compiling.current !== null) {
      compileAgain.current = true;
      return compiling.current;
    }
    const run = (async () => {
      let again = false;
      do {
        compileAgain.current = false;
        const target = savedRef.current;
        setViewProblem("");
        try {
          const requested = requestRef.current;
          // A view asked for while this read ran may have been read meanwhile, for this revision.
          if (again && adoptKnown(requested.key)) continue;
          again = true;
          const result = await reopenStudioApplication(
            organizationId,
            target.rootId,
            [requested.request],
            target.draftRevision,
          );
          if (requested.key !== requestRef.current.key) {
            compileAgain.current = true;
            continue;
          }
          if (!active.current) return;
          if (
            result.kind !== "available" ||
            result.organizationId !== organizationId ||
            result.draft.draftRevision !== savedRef.current.draftRevision ||
            result.draft.sourceFingerprint !== savedRef.current.sourceFingerprint
          ) {
            if (
              result.kind === "available" &&
              result.draft.draftRevision > savedRef.current.draftRevision &&
              statusRef.current.kind !== "conflict"
            ) {
              // Another window or person saved since: say so now rather than at the next edit.
              setStatus({
                kind: "conflict",
                changedBy: null,
                changedAt: result.draft.updatedAt,
                changes: summarizeSourceChange(
                  applicationSourceDocumentSchema.parse(savedRef.current.source),
                  applicationSourceDocumentSchema.parse(result.draft.source),
                ),
                message:
                  "A newer version of this draft was saved in another window or by someone else.",
              });
              return;
            }
            if (
              result.kind !== "available" ||
              result.draft.draftRevision < savedRef.current.draftRevision
            )
              console.error(
                `[studio] the saved draft's compile did not answer for revision ${savedRef.current.draftRevision}: STUDIO_COMPILE_REFRESH_${result.kind.toUpperCase()}`,
              );
            setViewProblem(
              "This editor could not load the saved draft with your current access. Try again or reload the latest draft.",
            );
            continue;
          }
          remember(result, [requested]);
          generation.current += 1;
          const loaded = { ...result.views[0]!, catalogue: result.catalogue };
          setView((previous) => viewOf(result, loaded, generation.current, previous));
        } catch (error) {
          console.error(
            "[studio] compiling the saved draft for the canvas failed",
            describeFailure(error),
          );
          if (active.current)
            setViewProblem("This editor could not load the saved draft. Try again.");
        }
      } while (compileAgain.current && active.current);
    })();
    compiling.current = run;
    try {
      await run;
    } finally {
      compiling.current = null;
    }
  }, [organizationId, remember, adoptKnown]);

  const loadAuthoringResources = useCallback(async () => {
    const target = savedRef.current;
    const targetLifetime = lifetimeRef.current;
    const result = await reopenStudioApplication(
      organizationId,
      target.rootId,
      [{ kind: "authoring" }],
      target.draftRevision,
    );
    if (
      !active.current ||
      targetLifetime !== lifetimeRef.current ||
      result.kind !== "available" ||
      result.organizationId !== organizationId ||
      result.draft.rootId !== target.rootId ||
      result.draft.draftRevision !== savedRef.current.draftRevision ||
      result.draft.sourceFingerprint !== savedRef.current.sourceFingerprint
    ) {
      console.error(
        "[studio] agent authoring resources did not answer for the current saved draft",
        result.kind,
      );
      return null;
    }
    const { catalogue } = result;
    const { borrowedChoices } = result.views[0]!;
    // Only the immutable catalogue survives the call. Revision-bound choices belong to its caller.
    catalogueRef.current = catalogue;
    setView((previous) => ({ ...previous, catalogue }));
    selection.reconcile({
      rootId: target.rootId,
      source: parsed(history.getState().source),
      catalogue,
    });
    return { catalogue, borrowedChoices };
  }, [organizationId, selection, parsed, history]);

  const scheduleSave = useCallback((delay: number) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveNow();
    }, delay);
  }, []);

  // One save of the newest entry; edits made while it runs are saved by the next one.
  const saveNow = useCallback(async (): Promise<void> => {
    clearTimeout(saveTimer.current);
    if (saving.current !== null) return saving.current;
    const before = history.getState();
    if (
      !active.current ||
      !before.isDirty ||
      holds.current.has("reopening") ||
      statusRef.current.kind === "conflict"
    )
      return;
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
            setStatus({
              kind: "refused",
              message: conflictMessage(
                outcome.reason,
                "Your edit is kept. Undo the import or correct the component names, and Studio saves again.",
              ),
            });
            return;
          }
          // Read through a function: TypeScript would otherwise narrow the ref to the null assigned before the awaited save.
          const latest = readElsewhere();
          if (outcome.reason !== "draft_changed" || latest === null) {
            setStatus({
              kind: "conflict",
              changedBy: null,
              changedAt: null,
              changes: [],
              message: conflictMessage(outcome.reason, "Your latest change was not saved."),
            });
            return;
          }
          const changes = summarizeSourceChange(
            applicationSourceDocumentSchema.parse(savedRef.current.source),
            applicationSourceDocumentSchema.parse(latest.draft.source),
          );
          const who = personWords(latest.changedBy);
          setStatus({
            kind: "conflict",
            changedBy: who,
            changedAt: latest.draft.updatedAt,
            changes,
            message: `${who ?? "Someone"} saved a newer version of this draft, so your latest change was not saved.`,
          });
          return;
        }
        case "refused":
          setStatus({
            kind: "refused",
            reason: outcome.reason,
            message:
              outcome.sentence ??
              refusalMessage(
                outcome.reason,
                "Your latest change was not saved; Undo it or change it, and Studio saves again.",
              ),
          });
          // An edit made while the refused save ran is a new attempt.
          if (after.isDirty && after.source !== before.source) scheduleSave(autosaveDelayMs);
          return;
        case "failed":
          retries.current += 1;
          if (retries.current > maximumRetries) {
            setStatus({
              kind: "refused",
              message:
                "The platform did not confirm several saves in a row. Your changes are kept on screen; Studio tries again with your next edit.",
            });
            return;
          }
          setStatus({
            kind: "failed",
            message:
              "The platform did not confirm the save. Studio tries again in a moment; your changes are kept.",
          });
          scheduleSave(retryDelayMs * 2 ** (retries.current - 1));
          return;
        case "busy":
          scheduleSave(autosaveDelayMs);
          return;
      }
    })();
    saving.current = run;
    try {
      await run;
    } finally {
      saving.current = null;
    }
  }, [history, refreshCompiled, scheduleSave]);

  useEffect(() => {
    active.current = true;
    lifetimeRef.current += 1;
    setLifetime(lifetimeRef.current);
    const unsubscribeHistory = history.subscribe((next) => {
      selection.reconcile({
        rootId: next.rootId,
        source: parsed(next.source),
        catalogue: catalogueRef.current,
      });
      setState(next);
      if (next.isSaving) return;
      // An edit after a refusal or a failure is a new attempt; a conflict waits for the latest draft.
      if (next.isDirty && statusRef.current.kind !== "conflict") {
        // Keep an unconfirmed save visible while its retry (or a newer edit) is in flight.
        if (statusRef.current.kind !== "saving" && statusRef.current.kind !== "failed")
          setStatus({ kind: "saving" });
        if (saving.current === null) scheduleSave(autosaveDelayMs);
      } else if (
        !next.isDirty &&
        statusRef.current.kind !== "saved" &&
        statusRef.current.kind !== "conflict"
      )
        setStatus({ kind: "saved" });
    });
    const unsubscribeSelection = selection.subscribe(setSelected);
    return () => {
      clearTimeout(saveTimer.current);
      const pending = history.getState();
      if (pending.isDirty && !pending.isSaving && statusRef.current.kind !== "conflict")
        void history.save();
      active.current = false;
      lifetimeRef.current += 1;
      unsubscribeHistory();
      unsubscribeSelection();
    };
  }, [history, selection, parsed, scheduleSave]);

  useEffect(() => {
    selection.reconcile({
      rootId: state.rootId,
      source: parsed(state.source),
      catalogue,
    });
  }, [selection, state.rootId, state.source, parsed, catalogue]);

  useEffect(() => {
    if (JSON.stringify(view.request) !== requestKey && !state.isDirty && !state.isSaving)
      void refreshCompiled();
  }, [requestKey, view.request, state.isDirty, state.isSaving, refreshCompiled]);

  // Leaving the page while a batch is waiting to be saved is confirmed by the browser.
  useLeaveWarning(state.isDirty || state.isSaving);

  const hold = useCallback((key: StudioDraftHold, on: boolean) => {
    if (holds.current.has(key) === on) return;
    if (on) holds.current.add(key);
    else holds.current.delete(key);
    setRenderedHolds(new Set(holds.current));
  }, []);

  const blockedReason = useCallback((): string | undefined => {
    if (!active.current) return "The workspace is closing.";
    if (holds.current.has("reopening")) return "The saved draft is loading. Try again in a moment.";
    if (holds.current.has("publication"))
      return "The draft is being published. Try again when it finishes.";
    if (holds.current.has("restoring"))
      return "A published version is being restored into the draft. Try again when it finishes.";
    if (statusRef.current.kind === "conflict")
      return "This draft was changed elsewhere. Load the latest draft before you change it.";
    return undefined;
  }, []);

  const run = useCallback(
    <Result>(
      command: (source: ApplicationSourceDocument) => StudioDraftStep<Result>,
      options: StudioRunOptions = {},
    ): StudioRunOutcome<Result> => {
      const blocked = blockedReason();
      if (blocked !== undefined) return { kind: "blocked", message: blocked };
      const current = history.getState();
      const currentSource = parsed(current.source);
      const stale = {
        kind: "blocked",
        message:
          "The draft changed while this was being checked, so nothing was changed. Try again.",
      } as const;
      if (
        options.expected !== undefined &&
        options.expected !== current.source &&
        options.expected !== currentSource
      )
        return stale;
      const step = command(currentSource);
      if (step.kind === "keep") return { kind: "done", result: step.result, changed: false };
      if (history.getState().source !== current.source) return stale;
      if (history.edit(step.source, options.merge))
        return { kind: "done", result: step.result, changed: true };
      if (canonicalJson(step.source) === canonicalJson(currentSource))
        return { kind: "done", result: step.result, changed: false };
      console.error(
        "[studio] the draft history refused a command's source: STUDIO_DRAFT_EDIT_REFUSED",
      );
      return {
        kind: "blocked",
        message: "The draft did not accept this change, so nothing was changed.",
      };
    },
    [blockedReason, history, parsed],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (saving.current !== null) await saving.current;
      const current = history.getState();
      if (
        !active.current ||
        statusRef.current.kind === "conflict" ||
        statusRef.current.kind === "refused"
      )
        return false;
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
      const requested = requestRef.current;
      const result = await reopenStudioApplication(organizationId, draft.rootId, [
        requested.request,
      ]);
      if (!active.current) return false;
      if (
        result.kind !== "available" ||
        result.organizationId !== draft.organizationId ||
        !history.reopen(result.draft)
      ) {
        console.error(
          `[studio] the latest saved draft could not be loaded: STUDIO_RELOAD_${result.kind.toUpperCase()}`,
        );
        return false;
      }
      savedRef.current = result.draft;
      setSaved(result.draft);
      remember(result, [requested]);
      generation.current += 1;
      const loaded = { ...result.views[0]!, catalogue: result.catalogue };
      setView((previous) => viewOf(result, loaded, generation.current, previous));
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
  }, [organizationId, draft.rootId, draft.organizationId, history, hold, remember]);

  const source = parsed(state.source);
  const retry = useCallback(async () => {
    if (!active.current || !history.getState().isDirty || blockedReason() !== undefined) return;
    retries.current = 0;
    setStatus({ kind: "saving" });
    await saveNow();
  }, [history, blockedReason, saveNow]);
  const updatingCanvas = view.draftRevision !== saved.draftRevision || state.isDirty;
  const words =
    status.kind === "saved" ? "Saved" : status.kind === "saving" ? "Saving…" : "Not saved";
  const chip =
    status.kind === "conflict" || status.kind === "refused"
      ? words
      : updatingCanvas
        ? `${words} · Updating canvas…`
        : words;
  const loadingView = JSON.stringify(view.request) !== requestKey;
  const locked =
    renderedHolds.size > 0 || status.kind === "conflict" || lifetime === 0 || loadingView;

  return useMemo<StudioDraft>(
    () => ({
      session,
      organizationId,
      history,
      selection,
      state,
      source,
      selected,
      saved,
      readSaved: () => savedRef.current,
      view,
      preview,
      readCatalogue: () => catalogueRef.current,
      loadingView,
      viewProblem,
      refreshView: refreshCompiled,
      loadAuthoringResources,
      updatingCanvas,
      status,
      chip,
      lifetime,
      locked,
      isHeld: (key) => renderedHolds.has(key),
      hold,
      blockedReason,
      parsed,
      run,
      select: (next) => selection.select(next),
      undo: () => {
        if (blockedReason() === undefined) history.undo();
      },
      redo: () => {
        if (blockedReason() === undefined) history.redo();
      },
      flush,
      retry,
      reload,
      isActive: () => active.current,
    }),
    [
      session,
      organizationId,
      history,
      selection,
      state,
      source,
      selected,
      saved,
      view,
      preview,
      loadingView,
      viewProblem,
      refreshCompiled,
      loadAuthoringResources,
      updatingCanvas,
      status,
      chip,
      lifetime,
      locked,
      renderedHolds,
      hold,
      blockedReason,
      parsed,
      run,
      flush,
      retry,
      reload,
    ],
  );
}
