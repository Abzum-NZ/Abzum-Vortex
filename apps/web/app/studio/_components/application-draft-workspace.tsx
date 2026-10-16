"use client";
import dynamic from "next/dynamic";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { applicationSourceDocumentSchema, canonicalJson, describeFailure,
  prepareDefinitionPublicationResultSchema, publishDefinitionResultSchema,
  type ApplicationSourceDocument, type DefinitionPublicationConfirmation,
  applicationModuleKeys, type PublishDefinitionResult, type ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import {
  applyStudioCompositionCommand,
  applyStudioVisibilityCondition,
  describeStudioCompositionAddTargets,
  studioDraftChoices,
  type StudioBorrowedQueries,
  type StudioCompositionOutcome,
  createStudioApplicationDraftHistoryController,
  createStudioSemanticSelectionStore,
  projectStudioSemanticOutline,
  resolveStudioSelectionInspectorContext,
  studioSemanticSelectionKey,
  traverseStudioSemanticSelectionDraft,
  type StudioStoredApplicationDraft,
  type StudioCompileFailure,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionDestination,
  isStudioDataSelection,
  type StudioSemanticSelection,
  type StudioSemanticOutlineNode,
} from "@vortex/ui/studio";
import { createAppearanceRootProps, type FieldInputControlReleaseMap, type PlatformThemeTokens } from "@vortex/ui";
import type { StudioCanvasAddRequest, StudioCanvasBreakpoint, StudioCanvasFrame } from "@vortex/ui/studio/page-puck-editor";
import { readStudioCanvasRecords, reopenStudioApplication, saveStudioApplication,
  prepareStudioApplicationPublication, publishStudioApplication, validateStudioPlacementThemeOverrides } from "../actions";
import { applyStudioItemLabels } from "../_lib/application-item-labels";
import { createStudioPlacementDescriber, studioOutlineLabels } from "../_lib/studio-labels";
import { ApplicationDraftAgentTools, type StudioPublicationOutcome } from "./application-draft-agent-tools";
import { ApplicationAppearanceEditor } from "./application-appearance-editor";
import { ApplicationCompositionEditor } from "./application-composition-editor";
import { ApplicationVisibilityConditionEditor, type StudioVisibilityWorkspaceSnapshot } from "./application-visibility-condition-editor";
import { useStudioFlowsTab } from "./use-studio-flows-tab";
import { previewStudioApplication } from "../preview-actions";
import type { SavedDraftContext } from "./application-draft-agent-tools";
import { ApplicationSourceImport } from "./application-source-import";
import { ApplicationSearchEditor } from "./application-search-editor";
import { StudioPublishDialog } from "./studio-publish-dialog";
import { StudioBlockSetupDialog, type StudioBlockSetupRequest } from "./studio-block-setup-dialog";
import { StudioHistoryTab } from "./studio-history-tab";
import { StandardPageAdoption } from "./standard-page-adoption";
import { useStudioDataTab } from "./studio-data-tab";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import type { StudioDataModule } from "../_lib/studio-data-model";
import { StudioTopBar } from "./studio-top-bar";
import { StudioCanvasToolbar, type StudioCanvasZoom } from "./studio-canvas-toolbar";
import { StudioInspector } from "./studio-inspector";
import { StudioReleasesPanel } from "./studio-releases-panel";
import {
  StudioBlockOutlinePanel, StudioComingNextPanel, StudioStructurePanel,
} from "./studio-outline-panels";
import { StudioMenuPanel } from "./studio-menu-panel";
import { StudioThemePanel, type StudioThemeChangeOutcome } from "./studio-theme-panel";
import { useStudioDraftTheme } from "./use-studio-draft-theme";
import { applyStudioMenuCommand, studioMenuPosition, type StudioMenuCommand, type StudioMenuResult } from "../_lib/application-menu";
import { studioDraftNavigation } from "../_lib/studio-draft-navigation";
import type { StudioThemeOptions } from "../_lib/studio-theme-options";
import {
  isStudioRailKey, isStudioReleasesSection, railShowsCanvas, studioRailTabs, studioReleasesSections,
  type StudioRailKey, type StudioReleasesSection,
} from "./studio-rail-tabs";
import { StudioFrame, StudioPanelShell } from "./studio-frame";
import { useStudioBusy } from "./use-studio-busy";
import type { StudioApplicationSearchMetadata } from "../../_lib/studio-application-draft";
import type { StudioApplicationCanvasFrames, StudioApplicationCompiledPageSlots } from "../../_lib/studio-application-draft";
import {
  sameStudioApplicationSourceImportSnapshot,
  type StudioApplicationSourceImportSnapshot,
} from "../_lib/application-source-import";
import { conflictMessage, previewProblem, refusalMessage, unavailableMessage } from "./studio-refusal-messages";
import { NewApplicationWorkspace } from "./new-application-workspace";
import { StudioStructureEditor } from "./studio-structure-editor";
import { applyStudioStructureCommand, type StudioStructureCommand, type StudioStructureResult } from "../_lib/application-structure";

// The Puck editor is the heaviest Studio dependency; load it only when a page is selected.
const ApplicationPagePuckEditor = dynamic(
  () => import("@vortex/ui/studio/page-puck-editor").then((module) => module.ApplicationPagePuckEditor),
  { ssr: false });

/**
 * The application frame the canvas draws the page inside: the compiled draft's shell, with the
 * draft's menu and theme as they are edited, so Menu and Theme changes show before a save.
 */
const canvasFrameFor = (frames: StudioApplicationCanvasFrames | null, pageAlias: string,
  source: ApplicationSourceDocument, theme: StudioCanvasFrame["theme"] | undefined): StudioCanvasFrame | undefined => {
  const page = frames?.pages[pageAlias];
  return frames === null || page === undefined || theme === undefined ? undefined : {
    applicationName: frames.applicationName, shells: frames.shells,
    theme, navigation: studioDraftNavigation(source, frames.pages), ...page,
  };
};

/** Where the workspace sits: the organisation it belongs to and the running application it builds. */
export type StudioWorkspacePlace = Readonly<{
  organizationName: string;
  /** The running application, for Back to app; absent when the organisation's address is unknown. */
  applicationHref: string | undefined;
}>;

type WorkspaceProps = Readonly<{
  platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}> & (
  | Readonly<{ mode: "new"; organizationId: string }>
  | Readonly<{ mode: "existing"; organizationId: string; draft: StudioStoredApplicationDraft;
      place: StudioWorkspacePlace;
      /** What the Theme tab offers, from the checked-in shadcn catalogue. */
      themeOptions: StudioThemeOptions;
      initialTab?: string | undefined;
      initialSection?: string | undefined;
      /** The key of a module to open in the Data tab. */
      initialModule?: string | undefined;
      /** The organisation's applications, to name and link the owner of a used module. */
      applications: readonly StudioModuleOwnerApplication[];
      searchMetadata?: StudioApplicationSearchMetadata | null;
      borrowedQueries?: StudioBorrowedQueries | null;
      /** The modules the application uses, read-only in the Data tab. */
      usedModules?: readonly StudioDataModule[] | null;
      pageCompiledSlots?: StudioApplicationCompiledPageSlots | null;
      canvasFrames?: StudioApplicationCanvasFrames | null;
      compileFailure?: StudioCompileFailure | null }>);

type PublicationSnapshot = Readonly<{
  organizationId: string; rootId: string; key: string; draftRevision: number;
  sourceFingerprint: string; source: object; selectionKey: string;
  lifetime: number; generation: number;
}>;
type PreparedPublication = Readonly<{
  confirmation: DefinitionPublicationConfirmation;
  componentLabels: readonly Readonly<{ componentId: string; label: string }>[];
  snapshot: PublicationSnapshot;
}>;
const samePublicationSnapshot = (left: PublicationSnapshot, right: PublicationSnapshot | null) =>
  right !== null && left.organizationId === right.organizationId && left.rootId === right.rootId &&
  left.key === right.key && left.draftRevision === right.draftRevision &&
  left.sourceFingerprint === right.sourceFingerprint && left.source === right.source &&
  left.selectionKey === right.selectionKey && left.lifetime === right.lifetime && left.generation === right.generation;


class StudioSaveError extends Error {
  constructor(readonly code: string, readonly reason?: string) {
    super(code);
    this.name = "StudioSaveError";
  }
}

/**
 * The page slots, frames and compile failure of one saved revision, with the source, revision and
 * fingerprint they were compiled from. The canvas draws and reads records only for this revision.
 */
type CompiledView = Readonly<{
  source: StudioStoredApplicationDraft["source"];
  draftRevision: number;
  sourceFingerprint: string;
  slots: StudioApplicationCompiledPageSlots | null;
  frames: StudioApplicationCanvasFrames | null;
  failure: StudioCompileFailure | null;
  generation: number;
}>;

/** Words a person can act on for a publication the platform declined. */
const publicationProblemText = (kind: string, reason: string | undefined, blockAlias?: string): string => {
  // A compilation refusal names its rule and, when it is about one, the block, so it can be fixed.
  if (reason?.startsWith("compilation_") === true) {
    const rule = reason.slice("compilation_".length).replace(/^vortex.definition./u, "").replaceAll("_", " ");
    return `This draft does not compile, so it cannot be published: ${rule}${blockAlias === undefined ? "" : ` (block ${blockAlias})`}. Change it, save, and try again.`;
  }
  switch (kind) {
    case "no_change": return "Nothing has changed since the last published version, so there is nothing new to publish.";
    case "dependency_unavailable":
      return "A module or component this application needs is not available in a compatible version. Publish or install it first.";
    case "conflict": return "The draft changed while this window was open. Close it and open Publish again.";
    case "temporarily_unavailable":
      return "Publishing could not be confirmed. It may have gone through: check Releases before trying again.";
    default: return unavailableMessage(kind === "refused" ? "refused" : "temporarily_unavailable", reason);
  }
};

export function ApplicationDraftWorkspace(props: WorkspaceProps) {
  return props.mode === "new"
    ? <NewApplicationWorkspace organizationId={props.organizationId} />
    : <ExistingApplicationWorkspace organizationId={props.organizationId} draft={props.draft} place={props.place}
        themeOptions={props.themeOptions}
        initialTab={isStudioRailKey(props.initialTab) ? props.initialTab : "structure"}
        initialSection={isStudioReleasesSection(props.initialSection) ? props.initialSection : "history"}
        initialModule={props.initialModule ?? null}
        applications={props.applications}
        initialSearchMetadata={props.searchMetadata ?? null}
        initialBorrowedQueries={props.borrowedQueries ?? null}
        initialUsedModules={props.usedModules ?? null}
        pageCompiledSlots={props.pageCompiledSlots ?? null}
        canvasFrames={props.canvasFrames ?? null}
        compileFailure={props.compileFailure ?? null}
        platformBlockCatalogue={props.platformBlockCatalogue}
        fieldInputControlReleases={props.fieldInputControlReleases}
        platformThemeTokens={props.platformThemeTokens} />;
}

function ExistingApplicationWorkspace({ organizationId, draft, place, initialTab, initialSection, initialModule, applications,
  initialSearchMetadata, initialBorrowedQueries, initialUsedModules, pageCompiledSlots, canvasFrames, compileFailure, platformBlockCatalogue, fieldInputControlReleases,
  platformThemeTokens, themeOptions }: {
  organizationId: string; draft: StudioStoredApplicationDraft; place: StudioWorkspacePlace;
  themeOptions: StudioThemeOptions;
  initialTab: StudioRailKey; initialSection: StudioReleasesSection; initialModule: string | null;
  applications: readonly StudioModuleOwnerApplication[];
  initialSearchMetadata: StudioApplicationSearchMetadata | null;
  initialBorrowedQueries: StudioBorrowedQueries | null;
  initialUsedModules: readonly StudioDataModule[] | null;
  pageCompiledSlots: StudioApplicationCompiledPageSlots | null;
  canvasFrames: StudioApplicationCanvasFrames | null;
  compileFailure: StudioCompileFailure | null;
  platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const active = useRef(false);
  const lifetime = useRef(0);
  const previewGeneration = useRef(0);
  const savedPreviewDraft = useRef(draft);
  const provisionalSave = useRef<Readonly<{ draft: StudioStoredApplicationDraft }> | null>(null);
  // Read through a function: TypeScript would otherwise narrow the ref to the null assigned before the awaited save.
  const readProvisionalSave = () => provisionalSave.current;
  const publicationEpoch = useRef(0);
  const publicationRequest = useRef<{ epoch: number; cancelled: boolean } | null>(null);
  const [tab, setTab] = useState<StudioRailKey>(initialTab);
  const [releasesSection, setReleasesSection] = useState<StudioReleasesSection>(initialSection);
  const [usedModules, setUsedModules] = useState<readonly StudioDataModule[] | null>(initialUsedModules);
  const [previewPending, setPreviewPending] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState<StudioCanvasZoom>(100);
  const [canvasBreakpoint, setCanvasBreakpoint] = useState<StudioCanvasBreakpoint>("desktop");
  // The canvas previews the application in light or dark; the running application keeps its own toggle.
  const [canvasAppearance, setCanvasAppearance] = useState<"light" | "dark">("light");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publicationNote, setPublicationNote] = useState("");
  const [publicationProblem, setPublicationProblem] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [publishedPublication, setPublishedPublication] = useState<PublishDefinitionResult | null>(null);
  const [preparedPublication, setPreparedState] = useState<PreparedPublication | null>(null);
  // The agent tools read the confirmation between calls, so the latest value is kept outside render state.
  const preparedRef = useRef<PreparedPublication | null>(null);
  const setPreparedPublication = useCallback((next: PreparedPublication | null | ((current: PreparedPublication | null) => PreparedPublication | null)) => {
    preparedRef.current = typeof next === "function" ? next(preparedRef.current) : next;
    setPreparedState(preparedRef.current);
  }, []);
  const [workspaceLifetime, setWorkspaceLifetime] = useState(0);
  const [history] = useState(() => createStudioApplicationDraftHistoryController(draft, {
    saveDraft: async (command) => {
      const requestLifetime = lifetime.current;
      const result = await saveStudioApplication(organizationId, command);
      if (!active.current || requestLifetime !== lifetime.current)
        throw new StudioSaveError("STUDIO_WORKSPACE_CLOSED");
      if (result.kind === "available") {
        provisionalSave.current = { draft: result.draft };
        return result.draft;
      }
      throw new StudioSaveError(result.kind === "conflict"
        ? "DEFINITION_DRAFT_STALE_OR_MISSING"
        : result.kind === "refused" ? "DEFINITION_CONTEXT_REFUSED" : "STUDIO_SAVE_FAILED",
        result.kind === "conflict" || result.kind === "refused" ? result.reason : undefined);
    },
  }));
  const [selection] = useState(() => createStudioSemanticSelectionStore({ rootId: draft.rootId, source: draft.source, catalogue: platformBlockCatalogue }));
  const [state, setState] = useState(() => history.getState());
  const [selected, setSelected] = useState(() => selection.getSelection());
  const [searchMetadata, setSearchMetadata] = useState<StudioApplicationSearchMetadata | null>(initialSearchMetadata);
  const [compiled, setCompiled] = useState<CompiledView>(() =>
    ({ source: draft.source, draftRevision: draft.draftRevision, sourceFingerprint: draft.sourceFingerprint,
      slots: pageCompiledSlots, frames: canvasFrames, failure: compileFailure, generation: 0 }));
  const [borrowedQueries, setBorrowedQueries] = useState<StudioBorrowedQueries | null>(initialBorrowedQueries);
  // A saved revision whose compile is still on its way: the canvas keeps the last compiled one meanwhile.
  const compileEpoch = useRef(0);
  const [compiling, setCompiling] = useState(false);
  const searchRefresh = useRef(0);
  const [refreshingSearch, setRefreshingSearch] = useState(false);
  const [message, setMessage] = useState("");
  const [label, setLabel] = useState("");
  // The selection the name and description fields were loaded for; a field loaded for another item is never an unapplied edit.
  const [labelKey, setLabelKey] = useState("");
  const [description, setDescription] = useState("");
  const [themeOverrideProblems, setThemeOverrideProblems] = useState(false);
  const [paletteHost, setPaletteHost] = useState<HTMLElement | null>(null);
  const [paletteMessage, setPaletteMessage] = useState("");
  const [blockSetup, setBlockSetup] = useState<StudioBlockSetupRequest | null>(null);
  const [appearanceEpoch, setAppearanceEpoch] = useState(0);
  const [appearanceValidationEpoch, setAppearanceValidationEpoch] = useState(0);
  const [compositionEpoch, setCompositionEpoch] = useState(0);
  const [conditionEpoch, setConditionEpoch] = useState(0);
  const [flowEpoch, setFlowEpoch] = useState(0);
  const sourceImportEpoch = useRef(0);
  const [sourceImportPanelEpoch, setSourceImportPanelEpoch] = useState(0);
  const sourceImportGeneration = useRef(0);

  const source = useMemo(() => applicationSourceDocumentSchema.parse(state.source), [state.source]);
  const draftTheme = useStudioDraftTheme({ organizationId, rootId: draft.rootId, theme: source.body.theme,
    compiledTheme: compiled.frames?.theme as StudioCanvasFrame["theme"] | undefined, compiledSourceTheme: compiled.source.body.theme });
  const inspector = resolveStudioSelectionInspectorContext({ rootId: state.rootId, source }, selected);
  const selectedPage = selected?.kind === "page"
    ? source.body.pages.find((page) => page.id === selected.pageAlias) : undefined;
  const editable = inspector.status === "resolved" &&
    (selected?.kind === "application" || (selected?.kind === "page" && selectedPage !== undefined));
  const currentLabel = selected?.kind === "application" ? source.body.name : selectedPage?.name ?? "";
  const selectionKey = selected === null ? "" : studioSemanticSelectionKey(selected);
  // The page or layout that holds each block: the canvas draws a block's page, the Outline lists its owner's blocks.
  const placementOwners = useMemo(() => {
    const owners = new Map<string, Readonly<{ kind: "page"; pageAlias: string } | { kind: "shell"; shellAlias: string }>>();
    traverseStudioSemanticSelectionDraft({ rootId: state.rootId, source, catalogue: platformBlockCatalogue }, ({ phase, node }) => {
      if (phase === "enter" && node.kind === "placement")
        owners.set(node.selection.placementAlias, node.owner.kind === "page"
          ? { kind: "page", pageAlias: node.owner.pageAlias } : { kind: "shell", shellAlias: node.owner.shellAlias });
    });
    return owners;
  }, [state.rootId, source, platformBlockCatalogue]);
  const selectedOwner = selected?.kind === "placement" ? placementOwners.get(selected.placementAlias) : undefined;
  // A menu entry shows the page it opens; the Menu and Theme tabs otherwise show the home page, so
  // their changes are seen in the application's frame.
  const selectedEntry = selected?.kind === "navigation" ? studioMenuPosition(source, selected.navigationItemAlias)?.item : undefined;
  const pageAliasOfKey = (key: string | undefined) => source.body.pages.find((page) => page.key === key)?.id;
  const canvasPageAlias = selected?.kind === "page" ? selected.pageAlias
    : selectedOwner?.kind === "page" ? selectedOwner.pageAlias
      : selectedEntry?.type === "page" ? pageAliasOfKey(selectedEntry.page) ?? pageAliasOfKey(source.body.home_page)
        : tab === "menu" || tab === "theme" ? pageAliasOfKey(source.body.home_page) : undefined;
  const canvasPage = canvasPageAlias === undefined ? undefined
    : source.body.pages.find((page) => page.id === canvasPageAlias);
  const canvasPageRef = useRef(canvasPage?.id);
  canvasPageRef.current = canvasPage?.id;
  useEffect(() => { setLabel(currentLabel); setDescription(source.body.description); setLabelKey(selectionKey); },
    [selectionKey, currentLabel, source.body.description]);
  const pendingLabels = editable && labelKey === selectionKey && (label !== currentLabel ||
    (selected?.kind === "application" && description !== source.body.description));

  // Every pending input or in-flight request in the workspace lives in this one place; a change invalidates previews.
  const busy = useStudioBusy({ labels: pendingLabels }, () => { previewGeneration.current += 1; });
  const readSourceImportSnapshot = (): StudioApplicationSourceImportSnapshot | null => {
    const current = history.getState();
    const saved = savedPreviewDraft.current;
    if (!active.current || busy.any("sourceImport") || current.isSaving || saved.organizationId !== organizationId ||
      saved.rootId !== current.rootId || saved.key !== draft.key || saved.draftRevision !== current.draftRevision) return null;
    const currentSelection = selection.getSelection();
    return {
      organizationId, rootId: current.rootId, key: draft.key, rootAlias: current.source.root_alias,
      draftRevision: current.draftRevision, savedSourceFingerprint: saved.sourceFingerprint,
      source: current.source, localLifetime: lifetime.current, generation: sourceImportGeneration.current,
      selectionKey: currentSelection === null ? "" : studioSemanticSelectionKey(currentSelection),
    };
  };
  const reportSourceImportPending = useCallback((pending: boolean, epoch: number) => {
    if (epoch === sourceImportEpoch.current) busy.report("sourceImport", pending);
  }, [busy]);
  const discardSourceImport = () => {
    sourceImportEpoch.current += 1;
    setSourceImportPanelEpoch(sourceImportEpoch.current);
    reportSourceImportPending(false, sourceImportEpoch.current);
  };
  const reportSearchPending = useCallback((pending: boolean) => { busy.report("search", pending); }, [busy]);
  const reportModuleFieldPending = useCallback((pending: boolean) => { busy.report("moduleField", pending); }, [busy]);
  const reportAppearancePending = useCallback((pending: boolean) => { busy.report("appearance", pending); }, [busy]);
  const reportCompositionPending = useCallback((pending: boolean) => { busy.report("composition", pending); }, [busy]);
  const reportConditionPending = useCallback((pending: boolean) => { busy.report("condition", pending); }, [busy]);
  const resetFlowPending = () => busy.clear("flowStep");

  useEffect(() => {
    active.current = true;
    lifetime.current += 1;
    setWorkspaceLifetime(lifetime.current);
    const unsubscribeHistory = history.subscribe((next) => {
      sourceImportGeneration.current += 1;
      publicationEpoch.current += 1;
      setPreparedPublication(null);
      previewGeneration.current += 1;
      selection.reconcile({ rootId: next.rootId, source: applicationSourceDocumentSchema.parse(next.source), catalogue: platformBlockCatalogue });
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

  // Leaving the page (a review page, another address, a reload) with edits that are not saved is confirmed by the browser.
  // Typed input that is not applied yet (name, appearance, composition, search, source import) is lost on unload too.
  const unsavedWork = state.isDirty || busy.anyRendered();
  useEffect(() => {
    if (!unsavedWork) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsavedWork]);

  const refreshSearchMetadata = async () => {
    const current = history.getState();
    if (!active.current || current.isDirty || current.isSaving || busy.any()) return;
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
          busy.any() ||
          result.kind !== "available" || result.searchMetadata === null || result.organizationId !== organizationId ||
          result.draft.rootId !== current.rootId || result.draft.key !== draft.key || result.draft.draftRevision !== current.draftRevision ||
          result.draft.sourceFingerprint !== saved.sourceFingerprint || canonicalJson(result.draft.source) !== canonicalJson(expectedSource)) return;
      const metadata = result.searchMetadata;
      if (metadata.organizationId !== organizationId || metadata.rootId !== current.rootId || metadata.draftRevision !== current.draftRevision ||
          metadata.sourceFingerprint !== saved.sourceFingerprint || metadata.bindingsSignature !== JSON.stringify(applicationModuleKeys(expectedSource))) return;
      setSearchMetadata(metadata);
    } catch (error) {
      console.error("[studio] refreshing the module list failed", describeFailure(error));
      if (active.current && lifetime.current === expectedLifetime && epoch === searchRefresh.current) setSearchMetadata(null);
    }
    finally { if (active.current && epoch === searchRefresh.current) setRefreshingSearch(false); }
  };
  const currentSearchMetadata = searchMetadata !== null && searchMetadata.organizationId === organizationId &&
    searchMetadata.rootId === state.rootId &&
    searchMetadata.draftRevision === state.draftRevision && searchMetadata.sourceFingerprint === savedPreviewDraft.current.sourceFingerprint &&
    searchMetadata.bindingsSignature === JSON.stringify(applicationModuleKeys(source)) &&
    canonicalJson(state.source) === canonicalJson(savedPreviewDraft.current.source) ? searchMetadata : null;
  const compositionContext = useMemo<StudioCompositionContext>(() => ({
    organizationId, rootId: state.rootId, key: draft.key, draftRevision: state.draftRevision,
    localLifetime: workspaceLifetime, catalogue: platformBlockCatalogue, source: state.source,
  }), [organizationId, state.rootId, draft.key, state.draftRevision, workspaceLifetime,
    platformBlockCatalogue, state.source]);

  // Read refs synchronously at every request and completion; rendered disabled state is advisory.
  const readPublicationSnapshot = (): PublicationSnapshot | null => {
    const current = history.getState();
    const saved = savedPreviewDraft.current;
    if (!active.current || busy.any("publication") || current.isSaving || current.isDirty ||
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
  }, [state, selected, busy, workspaceLifetime, organizationId, draft.key]);

  const requestPublication = async (mode: "prepare" | "publish", suppliedNote?: string): Promise<StudioPublicationOutcome> => {
    if (busy.is("publication")) return { kind: "not_started", reason: "busy" };
    if (readPublicationSnapshot() === null) return { kind: "not_started", reason: "not_saved" };
    const prepared = preparedRef.current;
    const note = (suppliedNote ?? publicationNote).trim();
    if (mode === "publish" && (prepared === null || note.length < 1 || note.length > 2000 ||
      !samePublicationSnapshot(prepared.snapshot, readPublicationSnapshot()))) {
      setPreparedPublication(null);
      setPublicationProblem("Check what will be published again and add a short note about what changed.");
      return { kind: "not_started", reason: prepared === null || note.length >= 1 && note.length <= 2000 ? "not_prepared" : "release_note_invalid" };
    }
    busy.report("publication", true);
    previewGeneration.current += 1;
    const snapshot = readPublicationSnapshot();
    if (snapshot === null) { busy.report("publication", false); return { kind: "not_started", reason: "not_saved" }; }
    const request = { epoch: ++publicationEpoch.current, cancelled: false };
    publicationRequest.current = request;
    setPreparedPublication(null);
    setPublicationProblem("");
    if (mode === "prepare") setPreparing(true);
    const superseded = () => !active.current || lifetime.current !== snapshot.lifetime || request.cancelled ||
      publicationRequest.current !== request || publicationEpoch.current !== request.epoch ||
      !samePublicationSnapshot(snapshot, readPublicationSnapshot());
    try {
      if (mode === "prepare") {
        const result = await prepareStudioApplicationPublication(organizationId, {
          rootId: snapshot.rootId, expectedDraftRevision: snapshot.draftRevision,
        });
        if (superseded()) return { kind: "discarded" };
        const parsed = result.kind === "available" ? prepareDefinitionPublicationResultSchema.safeParse(result.preparation) : null;
        if (parsed?.success && parsed.data.confirmation.rootId === snapshot.rootId &&
          parsed.data.confirmation.expectedDraftRevision === snapshot.draftRevision &&
          parsed.data.confirmation.sourceFingerprint === snapshot.sourceFingerprint) {
          setPreparedPublication({ confirmation: parsed.data.confirmation, componentLabels: parsed.data.componentLabels, snapshot });
          return { kind: "prepared", confirmation: parsed.data.confirmation };
        }
        if (result.kind === "available") {
          console.error("[studio] publication preparation did not match the saved draft: STUDIO_PUBLICATION_PREPARATION_MISMATCH");
          setPublicationProblem("The summary did not match the saved draft, so nothing can be published from it. Close this window and try again.");
          return { kind: "unverified" };
        }
        setPublicationProblem(publicationProblemText(result.kind, result.reason, "blockAlias" in result ? result.blockAlias : undefined));
        return { kind: "declined", result: result.kind, reason: result.reason };
      }
      if (prepared === null) return { kind: "not_started", reason: "not_prepared" };
      const result = await publishStudioApplication(organizationId, {
        confirmation: prepared.confirmation, releaseNote: note,
      });
      if (superseded()) return { kind: "discarded" };
      const parsed = result.kind === "available" ? publishDefinitionResultSchema.safeParse(result.publication) : null;
      const confirmation = prepared.confirmation;
      if (parsed?.success && parsed.data.rootId === confirmation.rootId &&
        parsed.data.releaseRevision === confirmation.expectedDraftRevision &&
        parsed.data.releaseVersion === confirmation.assignedVersion &&
        parsed.data.contentFingerprint === confirmation.contentFingerprint &&
        parsed.data.resolutionFingerprint === confirmation.resolutionFingerprint &&
        canonicalJson(parsed.data.dependencyManifest) === canonicalJson(confirmation.dependencyManifest)) {
        previewGeneration.current += 1;
        setPublishedPublication(parsed.data);
        return { kind: "published", publication: parsed.data };
      }
      if (result.kind === "available") {
        console.error("[studio] publication result did not match the confirmation: STUDIO_PUBLICATION_RESULT_MISMATCH");
        setPublicationProblem(publicationProblemText("temporarily_unavailable", undefined));
        return { kind: "unverified" };
      }
      setPublicationProblem(publicationProblemText(result.kind, result.reason, "blockAlias" in result ? result.blockAlias : undefined));
      // A transient failure of the append may still have completed.
      return result.kind === "temporarily_unavailable" ? { kind: "unverified" }
        : { kind: "declined", result: result.kind, reason: result.reason };
    } catch (error) {
      console.error(`[studio] publication ${mode} request failed: ${describeFailure(error)}`);
      if (active.current && lifetime.current === snapshot.lifetime && !request.cancelled)
        setPublicationProblem(mode === "prepare"
          ? "The platform could not read what will be published. Try again in a moment."
          : publicationProblemText("temporarily_unavailable", undefined));
      return { kind: "unverified" };
    } finally {
      // Cancellation never releases a potentially mutating request early or clears another owner.
      if (publicationRequest.current === request) {
        publicationRequest.current = null;
        busy.report("publication", false, false);
        if (active.current) setPreparing(false);
      }
    }
  };
  const openPublish = () => {
    setPublicationProblem("");
    setPublishedPublication(null);
    setPublicationNote("");
    setPublishOpen(true);
  };
  const closePublish = (open: boolean) => {
    if (open) return;
    publicationEpoch.current += 1;
    previewGeneration.current += 1;
    setPreparedPublication(null);
    if (publicationRequest.current !== null) publicationRequest.current.cancelled = true;
    setPublicationProblem("");
    setPublishOpen(false);
  };

  const readSavedDraftContext = useCallback((): SavedDraftContext | null => {
    const current = history.getState();
    const saved = savedPreviewDraft.current;
    if (!active.current || busy.any() || current.isSaving || current.isDirty ||
      saved.organizationId !== organizationId || saved.rootId !== current.rootId ||
      saved.key !== draft.key || saved.draftRevision !== current.draftRevision) return null;
    return { organizationId, rootId: current.rootId, draftRevision: current.draftRevision, source: current.source };
  }, [organizationId, draft.key, history, busy]);

  const readVisibilitySnapshot = useCallback((): StudioVisibilityWorkspaceSnapshot | null => {
    const current = history.getState();
    const currentSelection = selection.getSelection();
    if (!active.current || busy.anyOf("publication", "sourceImport", "search", "reopening") || current.isSaving ||
      currentSelection?.kind !== "placement") return null;
    return { context: { organizationId, rootId: current.rootId, key: draft.key,
      draftRevision: current.draftRevision, localLifetime: lifetime.current,
      catalogue: platformBlockCatalogue, source: current.source },
      selection: currentSelection, saved: savedPreviewDraft.current };
  }, [organizationId, draft.key, history, selection, busy, platformBlockCatalogue]);

  const applyLabels = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || busy.any("labels")) return;
    const applied = applyStudioItemLabels(state.source, selected, label, description);
    if (applied.kind === "not_found") return;
    if (applied.kind === "invalid") { setMessage("Enter a name and description within their length limits."); return; }
    history.edit(applied.source);
    setLabel(selected?.kind === "application" ? applied.source.body.name
      : applied.source.body.pages.find((page) => page.id === selectedPage?.id)?.name ?? currentLabel);
    setDescription(applied.source.body.description);
    setMessage("Name updated. Save to keep it.");
  };

  const applyPuckPageEdit = (expectedSource: ApplicationSourceDocument,
    nextSource: ApplicationSourceDocument) => {
    const current = history.getState();
    // The canvas edits the draft it was drawn from; any other change in between makes this one stale.
    if (!active.current || busy.any() || current.isSaving || canvasPageRef.current === undefined ||
      canonicalJson(expectedSource) !== canonicalJson(current.source)) return;
    const parsed = applicationSourceDocumentSchema.safeParse(nextSource);
    if (!parsed.success) {
      console.error("Failed to validate Puck page changes", parsed.error);
      setMessage("This page change could not be applied. Your saved draft and current edits are kept.");
      return;
    }
    if (parsed.data.key !== draft.key || parsed.data.root_alias !== current.source.root_alias ||
      !history.edit(parsed.data)) return;
    setMessage("Page changed. Save to keep it.");
  };

  // The compiled view of one saved revision, asked for after Save: Save only writes the draft. It
  // becomes current only if it answers for exactly that revision and nothing newer was saved since.
  const refreshCompiled = async (saved: StudioStoredApplicationDraft) => {
    const epoch = ++compileEpoch.current;
    const expectedLifetime = lifetime.current;
    setCompiling(true);
    try {
      const result = await reopenStudioApplication(organizationId, saved.rootId);
      if (!active.current || epoch !== compileEpoch.current || expectedLifetime !== lifetime.current) return;
      if (result.kind !== "available" || result.organizationId !== organizationId ||
        result.draft.draftRevision !== saved.draftRevision || result.draft.sourceFingerprint !== saved.sourceFingerprint) {
        console.error(`[studio] the saved draft's compile did not answer for revision ${saved.draftRevision}: STUDIO_COMPILE_REFRESH_${result.kind.toUpperCase()}`);
        setMessage("Saved. The canvas could not be updated from the saved draft; choose Revert to saved to reload it.");
        return;
      }
      setCompiled((previous) => ({ source: result.draft.source, draftRevision: result.draft.draftRevision,
        sourceFingerprint: result.draft.sourceFingerprint, slots: result.pageCompiledSlots, frames: result.canvasFrames,
        failure: result.compileFailure, generation: previous.generation + 1 }));
      setBorrowedQueries((previous) => result.borrowedQueries ?? previous);
      setUsedModules((previous) => result.usedModules ?? previous);
      searchRefresh.current += 1;
      setSearchMetadata(result.searchMetadata);
    } catch (error) {
      console.error("[studio] compiling the saved draft for the canvas failed", describeFailure(error));
      if (active.current && epoch === compileEpoch.current)
        setMessage("Saved. The canvas could not be updated from the saved draft; choose Revert to saved to reload it.");
    } finally {
      if (active.current && epoch === compileEpoch.current) setCompiling(false);
    }
  };

  const save = async () => {
    if (themeOverrideProblems || busy.any() || history.getState().isSaving) return;
    publicationEpoch.current += 1;
    setPreparedPublication(null);
    const requestLifetime = lifetime.current;
    provisionalSave.current = null;
    const result = await history.save();
    if (!active.current || requestLifetime !== lifetime.current) return;
    const returned = readProvisionalSave();
    const current = history.getState();
    // The writer response is evidence only after the unchanged history controller accepts it.
    if (result.kind === "saved" && returned !== null && !current.isDirty &&
      returned.draft.organizationId === organizationId && returned.draft.rootId === current.rootId &&
      returned.draft.key === draft.key && returned.draft.draftRevision === result.draftRevision &&
      current.draftRevision === result.draftRevision) {
      savedPreviewDraft.current = returned.draft;
      previewGeneration.current += 1;
      // The canvas keeps the last compiled revision until this one's compile answers.
      void refreshCompiled(returned.draft);
    }
    provisionalSave.current = null;
    setMessage(result.kind === "saved" ? "Saved."
      : result.kind === "conflict" ? `${conflictMessage(result.reason, "Your edits are kept.")} Choose Revert to saved to load the current saved draft.`
        : result.kind === "refused" ? refusalMessage(result.reason, "Your edits are kept.")
          : result.kind === "busy" ? "A save is already in progress."
            : "The save could not be confirmed. Your edits are kept; try again.");
    return result;
  };

  const reopen = async () => {
    if (busy.anyOf("publication", "reopening") || history.getState().isSaving) return;
    if ((history.getState().isDirty || busy.any("publication", "reopening")) &&
      !await confirm({
        title: "Discard your unsaved changes?",
        description: "Your unsaved changes are lost and the last saved draft is loaded again.",
        confirmLabel: "Discard changes",
      })) return;
    publicationEpoch.current += 1;
    setPreparedPublication(null);
    const requestLifetime = lifetime.current;
    busy.report("reopening", true);
    sourceImportGeneration.current += 1;
    previewGeneration.current += 1;
    setAppearanceValidationEpoch((value) => value + 1);
    setMessage("Reading the saved draft…");
    try {
      const result = await reopenStudioApplication(organizationId, draft.rootId);
      if (!active.current || requestLifetime !== lifetime.current) return;
      if (result.kind !== "available" || result.organizationId !== draft.organizationId || !history.reopen(result.draft)) {
        setMessage("The saved draft could not be loaded. Your edits are kept.");
        return;
      }
      savedPreviewDraft.current = result.draft;
      setSearchMetadata(result.searchMetadata);
      compileEpoch.current += 1;
      setCompiling(false);
      setCompiled((previous) => ({ source: result.draft.source, draftRevision: result.draft.draftRevision,
        sourceFingerprint: result.draft.sourceFingerprint, slots: result.pageCompiledSlots,
        frames: result.canvasFrames, failure: result.compileFailure, generation: previous.generation + 1 }));
      setBorrowedQueries((previous) => result.borrowedQueries ?? previous);
      setUsedModules((previous) => result.usedModules ?? previous);
      searchRefresh.current += 1;
      discardSourceImport();
      lifetime.current += 1;
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
      resetFlowPending();
      setMessage("Loaded the saved draft.");
    } catch (error) {
      console.error("[studio] reopening the saved draft failed", describeFailure(error));
      if (active.current && requestLifetime === lifetime.current)
        setMessage("The saved draft could not be loaded. Your edits are kept.");
    } finally {
      busy.report("reopening", false, false);
    }
  };

  // The one composition edit: the item editor's controls and the agent tools both come through here.
  const commandComposition = (expected: StudioCompositionContext, expectedSelection: StudioSemanticSelection,
    command: StudioCompositionCommand): StudioCompositionOutcome => {
    // Removing an item also waits for the item editor's own unapplied input.
    const blocked = () => !active.current || history.getState().isSaving ||
      busy.any(...(command.kind === "remove" ? [] : ["composition" as const]));
    const sameSelection = () => {
      const now = selection.getSelection();
      return now !== null && studioSemanticSelectionKey(now) === studioSemanticSelectionKey(expectedSelection);
    };
    const current = history.getState();
    if (blocked() || !sameSelection()) return { kind: "stale" };
    const currentSelection = selection.getSelection()!;
    const currentContext: StudioCompositionContext = {
      organizationId, rootId: current.rootId, key: draft.key,
      draftRevision: current.draftRevision, localLifetime: lifetime.current,
      catalogue: platformBlockCatalogue, source: current.source,
    };
    const result = applyStudioCompositionCommand(currentContext, expected, currentSelection, command);
    if (result.kind === "refused") return { kind: "refused", reason: result.reason };
    if (result.kind !== "applied") return { kind: result.kind };
    // No async boundary: still require the same history source and lifetime at the edit.
    const latest = history.getState();
    if (blocked() || !sameSelection() || latest.source !== current.source ||
      latest.rootId !== current.rootId || latest.draftRevision !== current.draftRevision ||
      lifetime.current !== currentContext.localLifetime) return { kind: "stale" };
    if (!history.edit(result.source)) return { kind: "invalid" };
    setMessage("Item changed. Save to keep it.");
    return { kind: "applied" };
  };

  // The one add path for a new block: a drop on the canvas, the palette's Add button and the setup dialog.
  const runAdd = (command: Extract<StudioCompositionCommand, { kind: "add" }>): string | true => {
    const current = history.getState();
    if (!active.current || current.isSaving || busy.any())
      return "Apply or discard your other change first, then add the block again.";
    const context: StudioCompositionContext = { organizationId, rootId: current.rootId, key: draft.key,
      draftRevision: current.draftRevision, localLifetime: lifetime.current,
      catalogue: platformBlockCatalogue, source: current.source };
    const result = applyStudioCompositionCommand(context, context, selection.getSelection(), command);
    if (result.kind === "refused") return result.reason;
    if (result.kind !== "applied" || !history.edit(result.source)) {
      console.error(`[studio] adding a block was refused: STUDIO_ADD_${result.kind.toUpperCase()}`);
      return "The block could not be added, so the draft is unchanged.";
    }
    if (result.placementAlias !== undefined) changeSelection({ kind: "placement", placementAlias: result.placementAlias });
    setMessage("Block added. Save to keep it.");
    return true;
  };
  const addTargets = useMemo(() => canvasPage === undefined ? null
    : describeStudioCompositionAddTargets(compositionContext, canvasPage.id), [compositionContext, canvasPage?.id]);
  // What reference settings and the query picker offer: queries that already exist (own, then borrowed), fields and pages.
  const draftChoices = useMemo(() => studioDraftChoices(source, borrowedQueries), [source, borrowedQueries]);
  // The records of the canvas's data blocks, read for the compiled saved revision only.
  const readCanvasRecords = useCallback(async (area: string) => {
    const pageAlias = canvasPageRef.current;
    if (pageAlias === undefined) return { state: "unavailable" as const, records: {}, notInstalled: [] };
    const result = await readStudioCanvasRecords(organizationId, { rootId: draft.rootId,
      draftRevision: compiled.draftRevision, sourceFingerprint: compiled.sourceFingerprint, pageAlias, area });
    if (result.kind === "available" && result.draftRevision === compiled.draftRevision &&
      result.sourceFingerprint === compiled.sourceFingerprint && result.pageAlias === pageAlias && result.area === area)
      return { state: "ready" as const, records: result.records, notInstalled: result.notInstalled };
    if (result.kind !== "not_installed")
      console.error(`[studio] the canvas records were not read: STUDIO_CANVAS_RECORDS_${result.kind.toUpperCase()}`);
    return { state: result.kind === "not_installed" ? "not_installed" as const : "unavailable" as const, records: {}, notInstalled: [] };
  }, [organizationId, draft.rootId, compiled.draftRevision, compiled.sourceFingerprint]);
  const sameDestination = (left: StudioCompositionDestination, right: StudioCompositionDestination) =>
    left.kind === "root" ? right.kind === "root"
      : right.kind === "child" && left.parentAlias === right.parentAlias && left.slotKey === right.slotKey;
  // A block for one place: added at once, or after its setup when it needs settings or data.
  const addBlock = (request: StudioCanvasAddRequest): boolean => {
    const pageAlias = canvasPageRef.current;
    if (pageAlias === undefined || addTargets?.kind !== "available") return false;
    const target = addTargets.targets.find((candidate) => candidate.area === request.area &&
      sameDestination(candidate.destination, request.destination));
    const choice = target?.choices.find((candidate) => candidate.rendererKey === request.rendererKey);
    // A block this place does not admit still goes to the add command, which names why it is refused.
    const release = choice ?? [...platformBlockCatalogue.releases].reverse()
      .find((candidate) => candidate.rendererKey === request.rendererKey);
    if (release === undefined) return false;
    const command = { kind: "add", pageAlias, area: request.area, destination: request.destination,
      index: request.index, blockId: release.blockId, releaseVersion: release.releaseVersion } as const;
    if (target !== undefined && choice !== undefined && choice.unavailable === undefined &&
      (choice.setup.length > 0 || choice.needsQuery)) {
      const page = source.body.pages.find((candidate) => candidate.id === pageAlias);
      setPaletteMessage("");
      setBlockSetup({ choice, target, pageQuery: page !== undefined && "query" in page ? page.query : undefined,
        add: (settings, query) => {
          const outcome = runAdd({ ...command, settings, query });
          if (outcome === true) setPaletteMessage(`${choice.name} added. Save to keep it.`);
          return outcome;
        } });
      return false;
    }
    const outcome = runAdd({ ...command, settings: {}, query: null });
    setPaletteMessage(outcome === true ? `${release.name} added. Save to keep it.` : outcome);
    return outcome === true;
  };

  // The outline's selection change, minus its confirmation: the agent tools refuse instead of discarding input.
  const changeSelection = (next: StudioSemanticSelection | null): boolean => {
    if (!selection.select(next)) return false;
    discardSourceImport();
    setConditionEpoch((value) => value + 1);
    reportConditionPending(false);
    // The Theme editor is the whole application's, not the selection's: it is reset only when it
    // holds input to discard. Remounting it on every selection re-ran its theme check, which held
    // the inspector busy for seconds after each click.
    if (busy.is("appearance")) {
      setAppearanceEpoch((value) => value + 1);
      reportAppearancePending(false);
    }
    setCompositionEpoch((value) => value + 1);
    reportCompositionPending(false);
    setFlowEpoch((value) => value + 1);
    resetFlowPending();
    return true;
  };
  // A selection from the outline or the canvas; unapplied input is discarded only after asking.
  const chooseSelection = async (next: StudioSemanticSelection | null): Promise<boolean> => {
    if (busy.is("publication") || busy.is("reopening") || history.getState().isSaving || (busy.any("publication", "reopening") &&
      !await confirm({
        title: "Switch to another item?",
        description: "You have changes that are not applied yet. They are discarded if you switch.",
        confirmLabel: "Discard and switch",
      }))) return false;
    // The name fields follow the new selection after it renders (see `labelKey`).
    return changeSelection(next);
  };
  const selectFromCanvas = (alias: string | null): Promise<boolean> => {
    const pageAlias = canvasPageRef.current;
    if (alias !== null) return chooseSelection({ kind: "placement", placementAlias: alias });
    return pageAlias === undefined ? Promise.resolve(false) : chooseSelection({ kind: "page", pageAlias });
  };
  const agentBlockedReason = (): string | undefined => {
    if (!active.current || busy.anyOf("reopening", "publication")) return "The workspace is busy opening or publishing. Try again in a moment.";
    if (history.getState().isSaving) return "A save is in progress. Try again in a moment.";
    if (busy.any("publication", "reopening")) return "A person has an unapplied edit in the workspace. Nothing was changed; ask them to apply or discard it.";
    return undefined;
  };

  // The centre draws the canvas for every rail tab except Data and Releases.
  const canvasShown = railShowsCanvas(tab);
  // The step inspector is drawn only on the Flows tab, so leaving it discards its unapplied input (after asking).
  const leaveFlows = async (): Promise<boolean> => {
    if (!busy.is("flowStep")) return true;
    if (!await confirm({
      title: "Leave the flow?",
      description: "Step settings you have not applied are discarded if you leave the Flows tab.",
      confirmLabel: "Discard and leave",
    })) return false;
    resetFlowPending();
    setFlowEpoch((value) => value + 1);
    return true;
  };
  const changeTab = async (next: StudioRailKey): Promise<boolean> => {
    if (next === tab) return true;
    if (tab === "flows" && !await leaveFlows()) return false;
    setTab(next);
    return true;
  };

  const describePlacement = useMemo(() => createStudioPlacementDescriber(platformBlockCatalogue), [platformBlockCatalogue]);
  const outline = useMemo(() => projectStudioSemanticOutline({ rootId: state.rootId, source, catalogue: platformBlockCatalogue }, describePlacement),
    [state.rootId, source, platformBlockCatalogue, describePlacement]);
  const labels = useMemo(() => studioOutlineLabels(outline), [outline]);
  const selectedName = selected === null ? undefined : labels.get(selectionKey);
  const savedStateLabel = state.isSaving ? "Saving…" : state.isDirty ? "Unsaved changes" : "Saved";
  const pendingNote = busy.isRendered("search")
    ? "Apply or discard your search settings before saving or changing anything else." : busy.isRendered("sourceImport")
    ? "Apply or discard the imported source before saving or changing anything else." : busy.isRendered("condition")
    ? "Apply or discard the visibility change before saving or undoing." : busy.isRendered("flowStep")
    ? "Apply or discard the step's settings before saving or undoing." : busy.isRendered("composition")
    ? "Apply or discard the item change before saving or undoing." : busy.isRendered("appearance")
    ? "Apply or discard the appearance change before saving or undoing." : pendingLabels
    ? "Apply or discard the name change before saving or undoing." : "";
  const locked = busy.anyRendered();
  const canPrepare = readPublicationSnapshot() !== null;
  const noEdit = state.isSaving || workspaceLifetime === 0;
  const flows = useStudioFlowsTab({ organizationId, draftKey: draft.key, rootId: draft.rootId, history, selectionStore: selection,
    busy, active, lifetime, workspaceLifetime, source, selected, catalogue: platformBlockCatalogue, labels, applications, pages: draftChoices.pages,
    disabled: noEdit || busy.anyRendered("flowStep"), epoch: flowEpoch, setMessage, choose: chooseSelection, select: changeSelection,
    openFlowsTab: () => changeTab("flows") });

  const commandVisibility: Parameters<typeof ApplicationVisibilityConditionEditor>[0]["onCommand"] =
    (expected, expectedSelection, metadata, condition, isCurrentResponse) => {
      const current = history.getState();
      const currentSelection = selection.getSelection();
      if (!active.current || current.isSaving || busy.any("condition") ||
        currentSelection?.kind !== "placement" || expectedSelection.kind !== "placement" ||
        currentSelection.placementAlias !== expectedSelection.placementAlias || !isCurrentResponse()) return { kind: "stale" };
      const currentContext: StudioCompositionContext = { organizationId, rootId: current.rootId, key: draft.key,
        draftRevision: current.draftRevision, localLifetime: lifetime.current,
        catalogue: platformBlockCatalogue, source: current.source };
      const result = applyStudioVisibilityCondition(expected, currentContext, currentSelection, metadata, condition);
      if (result.kind !== "applied") return result;
      const latest = history.getState();
      const latestSelection = selection.getSelection();
      if (!active.current || latest.isSaving || busy.any("condition") ||
        latest.source !== current.source || latest.rootId !== current.rootId ||
        latest.draftRevision !== current.draftRevision || lifetime.current !== currentContext.localLifetime ||
        latestSelection?.kind !== "placement" || latestSelection.placementAlias !== currentSelection.placementAlias ||
        !isCurrentResponse()) return { kind: "stale" };
      if (!history.edit(result.source)) return { kind: "invalid", issues: [] };
      setMessage("Visibility rule changed. Save to keep it.");
      return result;
    };

  const applySourceImport: Parameters<typeof ApplicationSourceImport>[0]["onApply"] = (expected, candidate) => {
    if (!sameStudioApplicationSourceImportSnapshot(expected, readSourceImportSnapshot())) return "stale";
    const parsed = applicationSourceDocumentSchema.safeParse(candidate);
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
    resetFlowPending();
    const currentSelection = selection.getSelection();
    setLabel(currentSelection?.kind === "application" ? parsed.data.body.name
      : currentSelection?.kind === "page"
        ? parsed.data.body.pages.find((page) => page.id === currentSelection.pageAlias)?.name ?? "" : "");
    setDescription(parsed.data.body.description);
    setMessage("Imported changes are in your draft. Save to keep them.");
    return "applied";
  };

  const applySearch: Parameters<typeof ApplicationSearchEditor>[0]["onApply"] = (expected, search) => {
    const current = history.getState();
    if (!active.current || lifetime.current !== workspaceLifetime || current.isSaving || current.isDirty ||
        busy.any("search") || canonicalJson(expected) !== canonicalJson(current.source) ||
        (search !== undefined && currentSearchMetadata === null)) return false;
    const candidate = structuredClone(expected);
    if (search === undefined) delete candidate.body.search;
    else candidate.body.search = search;
    const parsed = applicationSourceDocumentSchema.safeParse(candidate);
    if (!parsed.success || !history.edit(parsed.data)) return false;
    setSearchMetadata(null); searchRefresh.current += 1;
    setPreparedPublication(null); previewGeneration.current += 1;
    return true;
  };

  // Preview runs the saved draft as its own Application in a new tab, so it saves first. The tab is
  // opened at once, while the press still counts as the person's, and is closed if nothing runs.
  const openPreview = async () => {
    if (previewPending) return;
    const previewTab = window.open("", "_blank");
    setPreviewPending(true);
    try {
      if (history.getState().isDirty) {
        const result = await save();
        if (result?.kind !== "saved") { previewTab?.close(); return; }
      }
      const current = history.getState();
      setMessage("Starting the preview of the saved draft…");
      const result = await previewStudioApplication(organizationId, {
        rootId: current.rootId, draftRevision: current.draftRevision,
      });
      if (result.kind !== "provisioned") {
        previewTab?.close();
        setMessage(previewProblem(result));
        return;
      }
      if (previewTab === null) window.open(result.href, "_blank", "noopener");
      else previewTab.location.href = result.href;
      setMessage(`Preview of draft revision ${result.draftRevision} opened in a new tab.`);
    } catch {
      previewTab?.close();
      setMessage("The preview could not be started. Your changes are kept.");
    } finally {
      if (active.current) setPreviewPending(false);
    }
  };

  // A Data tab change (record type, module or field) is one edit of the application draft.
  const applyDataChange = (expected: ApplicationSourceDocument, next: ApplicationSourceDocument, change: string): boolean => {
    const current = history.getState();
    if (!active.current || lifetime.current !== workspaceLifetime || current.isSaving || busy.anyOf("publication", "reopening") ||
        canonicalJson(expected) !== canonicalJson(current.source)) return false;
    const parsed = applicationSourceDocumentSchema.safeParse(next);
    if (!parsed.success || !history.edit(parsed.data)) return false;
    busy.clear("moduleField");
    setMessage(change);
    return true;
  };
  const data = useStudioDataTab({ organizationId, rootId: state.rootId, source, saved: savedPreviewDraft.current.source,
    used: usedModules, applications, initialModule, hidden: tab !== "data",
    selection: isStudioDataSelection(selected) ? selected : null,
    disabled: noEdit || busy.anyOfRendered("publication", "reopening"), refresh: compiled.generation,
    search: <ApplicationSearchEditor source={source} metadata={currentSearchMetadata}
      disabled={busy.anyRendered("search") || state.isSaving || refreshingSearch || state.isDirty || workspaceLifetime === 0}
      onPendingChange={reportSearchPending} onRefresh={refreshSearchMetadata} onApply={applySearch} />,
    apply: applyDataChange, onFieldPending: reportModuleFieldPending,
    choose: (next) => { void chooseSelection(next); }, selectAfterEdit: (next) => { changeSelection(next); },
    openInTab: (nextTab, next) => { void changeTab(nextTab).then((changed) => { if (changed) void chooseSelection(next); }); },
  });

  const pageLabel = (pageAlias: string, fallback: string) =>
    labels.get(studioSemanticSelectionKey({ kind: "page", pageAlias })) ?? fallback;
  // The layout open in Outline: selected directly, or the layout that holds the selected block.
  const ownerShellKey = selected?.kind === "shell" ? selectionKey
    : selectedOwner?.kind === "shell" ? studioSemanticSelectionKey(selectedOwner) : undefined;
  const breadcrumbItem = canvasPage !== undefined ? pageLabel(canvasPage.id, canvasPage.name)
    : ownerShellKey === undefined ? undefined : labels.get(ownerShellKey);
  const outlineOwnerKey = canvasPage !== undefined ? studioSemanticSelectionKey({ kind: "page", pageAlias: canvasPage.id })
    : ownerShellKey;
  const centreTitle = tab === "data" ? data.title
      : tab === "releases" ? studioReleasesSections.find((entry) => entry.value === releasesSection)!.label
        : canvasPage !== undefined ? pageLabel(canvasPage.id, canvasPage.name)
          : inspector.status === "resolved" ? selectedName ?? inspector.descriptor.label : "Select an item";
  const chooseNode = (node: StudioSemanticOutlineNode) => { if (node.selection !== null) void chooseSelection(node.selection); };
  const outlinePanelProps = { outline, selectedKey: selectionKey, choose: chooseNode, disabled: busy.isRendered("publication") };
  // The Structure tab's one edit path: a checked command on the current draft, taken by the draft history.
  const commandStructure = (command: StudioStructureCommand): StudioStructureResult => {
    if (!active.current || busy.any() || history.getState().isSaving)
      return { kind: "refused", message: "Apply or discard the change that is waiting, or let the save finish, then try again." };
    const result = applyStudioStructureCommand({ source: history.getState().source, catalogue: platformBlockCatalogue, describePlacement }, command);
    if (result.kind !== "applied") return result;
    if (!history.edit(result.source))
      return { kind: "refused", message: "The draft history did not accept this change, so nothing was changed." };
    changeSelection(result.select ?? { kind: "application", applicationRootId: draft.rootId });
    setMessage(result.message);
    return result;
  };
  const homePage = source.body.pages.find((page) => page.key === source.body.home_page);
  // The Menu tab's one edit path, the same as Structure's: a checked command taken by the draft history.
  const commandMenu = (command: StudioMenuCommand): StudioMenuResult => {
    if (!active.current || busy.any() || history.getState().isSaving)
      return { kind: "refused", message: "Apply or discard the change that is waiting, or let the save finish, then try again." };
    const result = applyStudioMenuCommand(history.getState().source, command);
    if (result.kind !== "applied") return result;
    if (!history.edit(result.source))
      return { kind: "refused", message: "The draft history did not accept this change, so nothing was changed." };
    changeSelection(result.select === null ? null : { kind: "navigation", navigationItemAlias: result.select });
    setMessage(result.message);
    return result;
  };
  // A Theme tab change: resolved with publication's checks first, then one edit of the draft's theme selection.
  const changeThemeSelection = async (next: ApplicationSourceDocument["body"]["theme"]["selection"], what: string):
    Promise<StudioThemeChangeOutcome & Readonly<{ problems?: readonly string[] }>> => {
    const waiting = { kind: "refused", message: "Apply or discard the change that is waiting, or let the save finish, then try again." } as const;
    const before = history.getState();
    if (!active.current || busy.any("appearance") || before.isSaving) return waiting;
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(before.source));
    candidate.body.theme.selection = next;
    const result = await draftTheme.resolve(candidate.body.theme);
    if (result.kind !== "available")
      return { kind: "refused", message: result.kind === "refused"
        ? "The theme could not be checked for this draft with your access, so nothing was changed."
        : "The theme could not be checked just now, so nothing was changed. Try again." };
    if (!result.valid) return { kind: "refused", message: `${what}: refused, so nothing was changed.`, problems: result.problems };
    // The check is asynchronous: the change applies only to the draft it was checked against.
    if (!active.current || history.getState().source !== before.source || busy.any("appearance") || history.getState().isSaving)
      return { kind: "refused", message: "The draft changed while the theme was checked, so nothing was changed. Try again." };
    if (!history.edit(candidate)) return { kind: "refused", message: "The draft history did not accept this change, so nothing was changed." };
    setMessage(`${what}. Save to keep it.`);
    return { kind: "applied", message: `${what}. The canvas shows it; save to keep it.` };
  };

  const panels = <>
    <StudioStructurePanel {...outlinePanelProps} hidden={tab !== "structure"}
      homePageKey={homePage === undefined ? undefined : studioSemanticSelectionKey({ kind: "page", pageAlias: homePage.id })}
      editor={<StudioStructureEditor source={source} selected={selected} onCommand={commandStructure}
        disabled={busy.anyRendered() || state.isSaving || workspaceLifetime === 0} />} />
    <StudioBlockOutlinePanel {...outlinePanelProps} hidden={tab !== "outline"} ownerKey={outlineOwnerKey} />
    <StudioPanelShell title="Blocks" description="Blocks to add to the page on the canvas." hidden={tab !== "blocks"}>
      {/* The canvas's editor draws the palette here, so its blocks drag with the canvas's own drag and drop. */}
      <div ref={setPaletteHost} />
      {canvasPage === undefined && <p className="text-sm text-muted-foreground">Choose a page in Structure to add blocks to it.</p>}
    </StudioPanelShell>
    <StudioMenuPanel source={source} hidden={tab !== "menu"}
      selectedAlias={selected?.kind === "navigation" ? selected.navigationItemAlias : null}
      onSelect={(alias) => { void chooseSelection(alias === null ? null : { kind: "navigation", navigationItemAlias: alias }); }}
      onCommand={commandMenu} disabled={busy.anyRendered() || state.isSaving || workspaceLifetime === 0} />
    {data.panel}
    {flows.panel(tab !== "flows")}
    <StudioThemePanel hidden={tab !== "theme"} selection={source.body.theme.selection} options={themeOptions}
      disabled={busy.anyRendered("appearance") || state.isSaving || workspaceLifetime === 0} onChange={changeThemeSelection}
      advanced={<ApplicationAppearanceEditor key={appearanceEpoch} organizationId={organizationId}
        rootId={state.rootId} draftRevision={state.draftRevision} source={source}
        validationEpoch={appearanceValidationEpoch}
        disabled={busy.anyRendered("appearance") || state.isSaving} onPendingChange={reportAppearancePending}
        onApply={(expected, next) => {
          const current = history.getState();
          if (!active.current || lifetime.current !== workspaceLifetime || current.isSaving || busy.any("appearance") ||
              current.rootId !== state.rootId || current.draftRevision !== state.draftRevision ||
              current.source !== state.source || expected !== source) return false;
          const applied = history.edit(next);
          if (applied) setMessage("Appearance changed. Save to keep it.");
          return applied;
        }} />} />
    <StudioComingNextPanel title="Access" description="Who can see each page and block." hidden={tab !== "access"}>
      Roles, their permissions and each role&apos;s home page will be set here next. Today a selected block&apos;s
      visibility rule is set in the inspector.
    </StudioComingNextPanel>
    <StudioReleasesPanel hidden={tab !== "releases"} section={releasesSection} onSection={setReleasesSection}
      savedStateLabel={savedStateLabel} />
  </>;

  const inspectorPanel = <StudioInspector inspector={inspector}
    title={inspector.status === "resolved" ? selectedName ?? inspector.descriptor.label : ""}
    labels={editable ? {
      isApplication: selected?.kind === "application", label, description,
      inputDisabled: busy.anyRendered("labels", "appearance"), applyDisabled: busy.anyRendered("labels"),
      discardDisabled: busy.anyOfRendered("publication", "search", "sourceImport", "reopening") || !pendingLabels,
      onLabel: (value) => {
        if (busy.anyOf("publication", "sourceImport", "search", "condition", "reopening")) return;
        busy.touch("labels");
        setLabel(value);
      },
      onDescription: (value) => {
        if (busy.anyOf("publication", "sourceImport", "search", "condition", "reopening")) return;
        busy.touch("labels");
        setDescription(value);
      },
      onApply: applyLabels,
      onDiscard: () => {
        if (busy.anyOf("publication", "sourceImport", "search", "reopening")) return;
        setLabel(currentLabel); setDescription(source.body.description);
      },
    } : undefined}
    note={selected?.kind === "placement" ? undefined : selected?.kind === "flow" || selected?.kind === "flow_step"
      ? tab === "flows" ? undefined : "Open this flow in the Flows tab to change it."
      : selected === null ? undefined : selected.kind === "navigation" ? "Change this menu entry in the Menu tab."
        : selected.kind === "module" || selected.kind === "record_type" || selected.kind === "field" ? (tab === "data" ? undefined : "Change this in the Data tab.")
        : "This item cannot be edited here."}>
    {(selected?.kind === "flow" || selected?.kind === "flow_step") && tab === "flows" && inspector.status === "resolved" && flows.inspector}
    {selected?.kind === "placement" && inspector.status === "resolved" &&
      <ApplicationCompositionEditor key={compositionEpoch} context={compositionContext}
        selection={selected} disabled={busy.anyRendered("composition") || noEdit}
        choices={draftChoices}
        onPendingChange={reportCompositionPending} onCommand={commandComposition} />}
    {selected?.kind === "placement" && inspector.status === "resolved" &&
      <ApplicationVisibilityConditionEditor key={`${conditionEpoch}:${selectionKey}`} context={compositionContext}
        selection={selected} saved={savedPreviewDraft.current}
        busy={busy.anyOfRendered("publication", "search", "sourceImport", "reopening") || state.isSaving}
        disabled={busy.anyRendered("condition") || noEdit}
        readSnapshot={readVisibilitySnapshot} onPendingChange={reportConditionPending}
        onCommand={commandVisibility} />}
    {inspector.status === "resolved" && flows.placementWorkflows}
  </StudioInspector>;

  const canvasCentre = canvasShown && <section className={canvasPage !== undefined ? "space-y-3"
    : "space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground"} aria-label="Selected item">
    {selected?.kind === "application" && <p>{source.body.description}</p>}
    {selected?.kind === "placement" && canvasPage === undefined &&
      <p>This block is part of a layout. Change it in the inspector.</p>}
    {canvasPage === undefined && selected?.kind !== "flow" && selected?.kind !== "placement" &&
      <p className="text-sm text-muted-foreground">Choose a page in Structure to arrange it here.</p>}
    {/* The canvas measures its container, so it is drawn only while it is showing; its edits live in the draft history. */}
    {canvasPage !== undefined && draftTheme.problem.length > 0 && <p role="alert" className="text-sm text-destructive">{draftTheme.problem}</p>}
    {canvasPage !== undefined && (inspector.status === "resolved" || selected === null) &&
      // The canvas previews the application in light or dark: the appearance is set on the canvas only, never on Studio's frame.
      <div {...createAppearanceRootProps(canvasAppearance)} style={{ ...createAppearanceRootProps(canvasAppearance).style, zoom: canvasZoom / 100 }}>
        {/* A newly chosen icon library loads before the canvas draws with it; only the canvas waits. */}
        <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Drawing the canvas with the new theme…</p>}>
        <ApplicationPagePuckEditor key={`canvas:${canvasPage.id}`} source={source}
          compiledSource={compiled.source}
          platformBlockCatalogue={platformBlockCatalogue}
          fieldInputControlReleases={fieldInputControlReleases}
          platformThemeTokens={platformThemeTokens}
          pageAlias={canvasPage.id} compiledSlots={compiled.slots?.[canvasPage.id]}
          frame={canvasFrameFor(compiled.frames, canvasPage.id, source, draftTheme.theme)}
          selectedPlacementAlias={selected?.kind === "placement" ? selected.placementAlias : null}
          onSelectPlacement={selectFromCanvas}
          breakpoint={canvasBreakpoint}
          disabled={locked || noEdit}
          compileFailure={compiled.failure}
          validateThemeOverrides={(theme, placements) => validateStudioPlacementThemeOverrides(organizationId, {
            rootId: draft.rootId, expectedDraftRevision: history.getState().draftRevision, theme, placements })}
          onThemeOverrideProblems={setThemeOverrideProblems}
          onChange={applyPuckPageEdit}
          readRecords={readCanvasRecords} updating={compiling}
          palette={addTargets === null ? undefined
            : { host: paletteHost, targets: addTargets, message: paletteMessage, onAdd: addBlock }} />
        </Suspense>
      </div>}
  </section>;

  return <div aria-busy={busy.isRendered("publication") || state.isSaving || busy.isRendered("reopening")}>
    <ApplicationDraftAgentTools organizationId={organizationId} history={history}
      catalogue={platformBlockCatalogue} readLifetime={() => lifetime.current} blockedReason={agentBlockedReason}
      select={changeSelection} command={commandComposition} save={save}
      readQueries={() => studioDraftChoices(applicationSourceDocumentSchema.parse(history.getState().source), borrowedQueries).queries}
      readPreparedConfirmation={() => preparedRef.current?.confirmation}
      prepare={() => requestPublication("prepare")} publish={(releaseNote) => requestPublication("publish", releaseNote)}
      readSavedDraft={readSavedDraftContext} />
    <StudioFrame tabs={studioRailTabs} activeTab={tab} onTabChange={changeTab}
      topBar={<StudioTopBar
        location={{ organizationName: place.organizationName, organizationHref: `/studio/${encodeURIComponent(organizationId)}`,
          applicationName: source.body.name, item: breadcrumbItem,
          onApplication: () => { void chooseSelection({ kind: "application", applicationRootId: draft.rootId }); } }}
        savedStateLabel={savedStateLabel} status={`${pendingNote} ${message}`}
        canUndo={state.canUndo} canRedo={state.canRedo} undoDisabled={locked}
        onUndo={() => { if (!busy.any()) history.undo(); }} onRedo={() => { if (!busy.any()) history.redo(); }}
        onRevert={() => { void reopen(); }} revertDisabled={busy.anyOfRendered("publication", "reopening") || state.isSaving}
        onSave={() => { void save(); }} saveDisabled={!state.isDirty || themeOverrideProblems || state.isSaving || locked}
        backToAppHref={place.applicationHref}
        onPreview={() => { void openPreview(); }} previewPending={previewPending}
        previewDisabled={state.isSaving || locked || themeOverrideProblems}
        onPublish={openPublish} publishDisabled={busy.isRendered("reopening") || state.isSaving || locked} />}
      panel={panels}
      inspector={tab === "data" ? data.inspector : inspectorPanel}
      canvas={({ inspectorOpen, toggleInspector }) => <>
        <StudioCanvasToolbar title={centreTitle} breakpoint={canvasBreakpoint} onBreakpoint={setCanvasBreakpoint}
          zoom={canvasZoom} onZoom={setCanvasZoom} showsCanvas={canvasShown && canvasPage !== undefined}
          appearance={canvasAppearance} onAppearance={setCanvasAppearance}
          inspectorOpen={inspectorOpen} onToggleInspector={toggleInspector} />
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {canvasCentre}
          {tab === "flows" && flows.centre}
          {/* The Data tab's field editor keeps its unapplied input while another tab is open. */}
          <div hidden={tab !== "data"}>{data.centre}</div>
          {tab === "releases" && releasesSection === "history" &&
            <StudioHistoryTab organizationId={organizationId} rootId={state.rootId} savedRevision={savedPreviewDraft.current.draftRevision} />}
          {tab === "releases" && releasesSection === "page-adoption" &&
            <StandardPageAdoption organizationId={organizationId} rootId={state.rootId}
              disabledReason={state.isDirty || locked ? "Save your changes first; a choice here changes the saved draft." : undefined}
              onSaved={() => { void reopen(); }} />}
          {/* The import keeps its unapplied input (and its pending flag) while another tab is open. */}
          <section hidden={tab !== "releases" || releasesSection !== "import"} aria-label="Import from source"
            className="space-y-3">
            <p className="text-sm text-muted-foreground">Replace the draft with a source document. This is for advanced use; the change is checked before it reaches your draft.</p>
            <ApplicationSourceImport key={sourceImportPanelEpoch}
              disabled={busy.anyRendered("sourceImport") || noEdit}
              readSnapshot={readSourceImportSnapshot}
              onPendingChange={(pending) => reportSourceImportPending(pending, sourceImportPanelEpoch)}
              onApply={applySourceImport} />
          </section>
        </div>
      </>} />
    <StudioPublishDialog open={publishOpen} onOpenChange={closePublish}
      hasUnsavedChanges={state.isDirty} saving={state.isSaving} onSave={() => { void save(); }}
      canPrepare={canPrepare} preparing={preparing} publishing={busy.isRendered("publication") && !preparing}
      prepared={preparedPublication} note={publicationNote} onNoteChange={setPublicationNote}
      problem={publicationProblem} published={publishedPublication}
      onPrepare={() => { void requestPublication("prepare"); }}
      onPublish={() => { void requestPublication("publish"); }} />
    <StudioBlockSetupDialog request={blockSetup} choices={draftChoices} onClose={() => setBlockSetup(null)} />
    {data.dialog}
    {confirmDialog}
  </div>;
}
