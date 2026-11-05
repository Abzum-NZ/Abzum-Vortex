"use client";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useStable } from "./use-stable";
import {
  describeFailure,
  type SourceIdentityReservation,
  createStudioPlacementDescriber,
  projectStudioSemanticOutline,
  studioSemanticSelectionKey,
  type StudioSemanticSelection,
  type StudioStoredApplicationDraft,
  applyStudioAccessCommand,
  studioAccessIdentityReservations,
  type StudioAccessCommand,
  type StudioAccessResult,
  type StudioNavigationApplication,
  type StudioNavigationApplicationsStatus,
} from "@vortex/platform/schema";
import { StudioFieldProblemsProvider } from "@vortex/ui/studio";
import { studioOutlineLabels } from "../_lib/studio-labels";
import { studioPlaceSelection, studioTabOfSelection } from "../_lib/studio-places";
import { describeStudioCompileFailure } from "../_lib/studio-compile-failure";
import { ApplicationDraftAgentTools } from "./application-draft-agent-tools";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import { useStudioAccessTab } from "./studio-access-tab";
import { useStudioDataTab } from "./studio-data-tab";
import { StudioFrame } from "./studio-frame";
import {
  isStudioRailKey,
  isStudioReleasesSection,
  railShowsCanvas,
  studioRailTabs,
  type StudioRailKey,
  type StudioReleasesSection,
} from "./studio-rail-tabs";
import { StudioSaveState } from "./studio-save-state";
import { StudioHeader, type StudioFrameDefinition } from "./studio-header";
import type { ApplicationReleaseStanding } from "../../_lib/application-release-adoption";
import { StudioPlaceOpenerProvider, type StudioPlaceOpener } from "./studio-used-in";
import {
  StudioPuckProvider,
  useStudioDragGate,
  whenNotDragging,
} from "@vortex/ui/studio/puck-provider";
import { useStudioCanvasTab } from "./use-studio-canvas-tab";
import { useStudioDraft } from "./use-studio-draft";
import { useStudioDraftTheme } from "./use-studio-draft-theme";
import { useStudioFlowsTab } from "./use-studio-flows-tab";
import { useStudioMenuThemeTabs } from "./use-studio-menu-theme-tabs";
import { useStudioReleasesTab } from "./use-studio-releases-tab";
import { useStudioStructureCommand, useStudioStructureTab } from "./use-studio-structure-tab";
import { Button } from "@vortex/ui/components/button";
import type { StudioStructureForm } from "./studio-structure-editor";

/**
 * The Navigate targets as they are read: the targets, or `failed` when the installed applications
 * could not be read (the page has already said so once). A genuine throw still rejects.
 */
export type StudioNavigationTargets = Promise<
  | Readonly<{ kind: "ready"; targets: readonly StudioNavigationApplication[] }>
  | Readonly<{ kind: "failed" }>
>;

/** Where the workspace sits: the organisation it belongs to and the running application it builds. */
export type StudioWorkspacePlace = Readonly<{
  organizationName: string;
  /** Studio's shared application frame: its top bar, the signed-in person and the addresses. */
  frame: StudioFrameDefinition;
  /** Where the application stood in the organisation when the editor opened. */
  standing: ApplicationReleaseStanding;
  /**
   * The other applications a Navigate step can open, with their pages. Read beside the editor's
   * first load and delivered when finished: the Flows tab lists them once they arrive.
   */
  navigationTargets: StudioNavigationTargets;
}>;

type WorkspaceProps = Readonly<{
  mode: "existing";
  organizationId: string;
  draft: StudioStoredApplicationDraft;
  place: StudioWorkspacePlace;
  initialTab?: string | undefined;
  initialSection?: string | undefined;
  initialModule?: string | undefined;
  initialRecordType?: string | undefined;
  applications: readonly StudioModuleOwnerApplication[];
  initialView: Parameters<typeof useStudioDraft>[0]["initialView"];
}>;

type ExistingProps = Extract<WorkspaceProps, { mode: "existing" }>;

export function ApplicationDraftWorkspace(props: WorkspaceProps) {
  return <ExistingApplicationWorkspace {...props} />;
}

/**
 * The one Studio workspace for an existing application. It only composes: the draft store (history,
 * one selection, autosave and the compiled view) and one controller per rail tab, each editing the
 * draft through the store's single command envelope.
 */
function ExistingApplicationWorkspace(props: ExistingProps) {
  const { organizationId, place, applications } = props;
  // The Navigate targets arrive after the editor has opened; the Flows tab lists them from then on.
  const [navigation, setNavigation] = useState<
    Readonly<{
      status: StudioNavigationApplicationsStatus;
      targets: readonly StudioNavigationApplication[];
    }>
  >({ status: "loading", targets: [] });
  useEffect(() => {
    let current = true;
    place.navigationTargets.then(
      (result) => {
        if (current)
          setNavigation(
            result.kind === "ready"
              ? { status: "ready", targets: result.targets }
              : { status: "failed", targets: [] },
          );
      },
      (error: unknown) => {
        if (!current) return;
        console.error("[studio] the Navigate targets could not be read", describeFailure(error));
        setNavigation({ status: "failed", targets: [] });
      },
    );
    return () => {
      current = false;
    };
  }, [place.navigationTargets]);
  const [tab, setCurrentTab] = useState<StudioRailKey>(
    isStudioRailKey(props.initialTab) ? props.initialTab : "structure",
  );
  // A block being dragged keeps its canvas: the rail tab and the open page change after the drop.
  const dragGate = useStudioDragGate();
  const setTab = useCallback(
    (next: StudioRailKey) => whenNotDragging(dragGate, () => setCurrentTab(next)),
    [dragGate],
  );
  const [structureForm, setStructureForm] = useState<StudioStructureForm>("none");
  const draft = useStudioDraft({
    organizationId,
    draft: props.draft,
    tab,
    creation:
      structureForm === "shell" ? "layout" : structureForm === "record" ? "record_page" : undefined,
    initialView: props.initialView,
    dragGate,
  });
  const catalogue = draft.view.catalogue;
  // Every way of opening a tab shares this state, including rule links and the rail.
  useEffect(() => {
    const url = new URL(window.location.href);
    // The Releases tab's section belongs to that tab alone.
    const leavesSection = tab !== "releases" && url.searchParams.has("section");
    if (url.searchParams.get("tab") === tab && !leavesSection) return;
    url.searchParams.set("tab", tab);
    if (tab !== "releases") url.searchParams.delete("section");
    window.history.replaceState(window.history.state, "", url);
  }, [tab]);
  useEffect(() => {
    const restoreTab = () => {
      const next = new URL(window.location.href).searchParams.get("tab");
      setTab(isStudioRailKey(next ?? undefined) ? (next as StudioRailKey) : "structure");
    };
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);
  const { source, state } = draft;
  const accessReservations = useRef<SourceIdentityReservation[]>([]);
  const openIn = (nextTab: StudioRailKey, next: StudioSemanticSelection) => {
    setTab(nextTab);
    draft.select(next);
  };

  // The one outline of the draft: Structure, Outline and every label Studio shows are views of it.
  // Drawn after the keystroke that changed the draft: the canvas and the field answer first. The
  // commands and the canvas name blocks from the current draft.
  const describePlacement = useMemo(
    () => createStudioPlacementDescriber(catalogue, source),
    [catalogue, source],
  );
  const outlineSource = useDeferredValue(source);
  const outline = useMemo(
    () =>
      projectStudioSemanticOutline(
        { rootId: state.rootId, source: outlineSource, catalogue },
        createStudioPlacementDescriber(catalogue, outlineSource),
      ),
    [state.rootId, outlineSource, catalogue],
  );
  const labels = useMemo(() => studioOutlineLabels(outline), [outline]);
  // Every "Used in" entry and "Show me where" link opens its place in its own tab, selected.
  const placeOpener: StudioPlaceOpener = {
    open: (target) => {
      if (target.kind === "access_permissions") {
        openAccessPermissions();
        return;
      }
      const next = studioPlaceSelection(target, state.rootId);
      if (next === null) return;
      // The Access tab may be showing another of its views while the role is already selected.
      if (next.kind === "role") access.showRole();
      openIn(studioTabOfSelection(next), next);
    },
    nameOf: (open) => {
      const next = studioPlaceSelection(open, state.rootId);
      return next === null ? undefined : labels.get(studioSemanticSelectionKey(next));
    },
  };
  const theme = useStudioDraftTheme({
    organizationId,
    rootId: state.rootId,
    theme: source.body.theme,
    compiledTheme: draft.view.frames?.theme,
    compiledSourceTheme: draft.view.source.body.theme,
    enabled: draft.view.request.kind === "canvas" || draft.view.request.kind === "theme",
  });

  const flows = useStudioFlowsTab({
    draft,
    catalogue,
    labels,
    applications,
    navigationTargets: navigation.targets,
    navigationStatus: navigation.status,
    hidden: tab !== "flows",
    openFlowsTab: () => setTab("flows"),
  });
  const structureCommand = useStudioStructureCommand({ draft, catalogue, describePlacement });
  const canvas = useStudioCanvasTab({
    draft,
    tab,
    catalogue,
    describePlacement,
    structure: structureCommand,
    fieldInputControlReleases: draft.view.fieldInputControlReleases,
    platformThemeTokens: draft.view.platformThemeTokens,
    outline,
    labels,
    theme,
    flowsInspector: flows.inspector,
    placementWorkflows: flows.placementWorkflows,
    flowDeleteActions: flows.deleteActions,
    flowDeleteNotice: flows.deleteNotice,
    applications,
    openTab: setTab,
  });

  // The Access tab's one edit path, the same envelope as every other tab.
  const commandAccess = (command: StudioAccessCommand, merge?: string): StudioAccessResult => {
    const reservations = draft.view.identityReservations;
    if (reservations === null)
      return { kind: "refused", message: "Access is still loading. Try again in a moment." };
    const outcome = draft.run<StudioAccessResult>(
      (current) => {
        const known = new Set(
          accessReservations.current.map(
            (entry) => `${entry.definitionKey}:${entry.kind}:${entry.alias}`,
          ),
        );
        accessReservations.current.push(
          ...[...reservations, ...studioAccessIdentityReservations(current)].filter(
            (entry) => !known.has(`${entry.definitionKey}:${entry.kind}:${entry.alias}`),
          ),
        );
        const result = applyStudioAccessCommand(current, command, accessReservations.current);
        return result.kind === "applied"
          ? { kind: "edit", source: result.source, result }
          : { kind: "keep", result };
      },
      { merge },
    );
    return outcome.kind === "blocked"
      ? { kind: "refused", message: outcome.message }
      : outcome.result;
  };
  const access = useStudioAccessTab({
    source,
    selected: draft.selected,
    select: draft.select,
    compiledRoles: draft.view.frames?.roles,
    hidden: tab !== "access",
    disabled: draft.locked,
    onCommand: commandAccess,
    onPreview: canvas.previewAs,
  });
  const openAccessPermissions = () => {
    access.showPermissions();
    setTab("access");
  };
  const openAccessPages = () => {
    access.showPages();
    setTab("access");
  };
  const structure = useStudioStructureTab({
    draft,
    catalogue,
    describePlacement,
    structure: structureCommand,
    outline,
    hidden: tab !== "structure",
    openAccessPages,
    form: structureForm,
    onFormChange: setStructureForm,
  });
  const menuTheme = useStudioMenuThemeTabs({
    draft,
    menuHidden: tab !== "menu",
    themeHidden: tab !== "theme",
    themeOptions: draft.view.themeOptions,
    theme,
    openAccessPages,
  });
  const data = useStudioDataTab({
    draft,
    applications,
    initialModule: props.initialModule ?? null,
    initialRecordType: props.initialRecordType ?? null,
    hidden: tab !== "data",
    compositionContext: canvas.compositionContext,
    readRecords: canvas.readRecordChoices,
    structure: structureCommand,
  });
  const releases = useStudioReleasesTab({
    draft,
    showPlace: (moduleKey, recordKey) => {
      const module = draft.source.body.modules.find((entry) => entry.key === moduleKey);
      if (module === undefined) return false;
      draft.select(
        recordKey === undefined
          ? { kind: "module", moduleKey }
          : { kind: "record_type", moduleKey, recordKey },
      );
      setTab("data");
      return true;
    },
    initialStanding: place.standing,
    hidden: tab !== "releases",
    initialSection: isStudioReleasesSection(props.initialSection)
      ? props.initialSection
      : ("history" as StudioReleasesSection),
  });

  const centreTitle =
    tab === "data"
      ? data.title
      : tab === "access"
        ? access.title
        : tab === "releases"
          ? releases.title
          : canvas.title;
  const canvasShown = railShowsCanvas(tab);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;
      // The physical key, so the shortcuts also work on layouts that do not type Latin letters.
      const key =
        event.code === "KeyZ" ? "z" : event.code === "KeyY" ? "y" : event.key.toLowerCase();
      // Undo is Ctrl+Z; Redo is Ctrl+Shift+Z or Ctrl+Y. Studio's draft history is the one history:
      // Puck's own hotkeys have nothing to go back to.
      const redo = key === "y" ? !event.shiftKey : key === "z" && event.shiftKey;
      if (key !== "z" && !redo) return;
      event.preventDefault();
      // A modal owns its actions. Also prevent native Undo reaching the previously focused input.
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]'))
        return;
      if (redo) draft.redo();
      else draft.undo();
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [draft]);

  // The header's commands keep their identity between keystrokes, so its buttons are not drawn again.
  const onApplication = useStable(() => {
    draft.select({ kind: "application", applicationRootId: state.rootId });
  });
  const onUndo = useStable(() => draft.undo());
  const onRedo = useStable(() => draft.redo());
  const onInstall = useStable(() => releases.openInstall());
  const onPreview = useStable(() => releases.openPreview());
  const onPublish = useStable(() => releases.openPublish());
  return (
    <StudioFieldProblemsProvider>
      <StudioPlaceOpenerProvider opener={placeOpener}>
        <div
          className="flex h-full min-h-0 flex-col"
          aria-busy={draft.isHeld("publication") || draft.isHeld("reopening")}
        >
          <ApplicationDraftAgentTools
            draft={draft}
            command={canvas.commandComposition}
            rename={canvas.renameItem}
            readQueries={canvas.readQueries}
            {...releases.agent}
          />
          <StudioPuckProvider input={canvas.puck} dragGate={dragGate}>
            <StudioFrame
              tabs={studioRailTabs}
              activeTab={tab}
              onTabChange={setTab}
              selectionKey={
                draft.selected === null ? "" : studioSemanticSelectionKey(draft.selected)
              }
              topBar={
                <StudioHeader
                  frame={place.frame}
                  applicationName={source.body.name}
                  onApplication={onApplication}
                  saveState={<StudioSaveState draft={draft} />}
                  canUndo={state.canUndo}
                  canRedo={state.canRedo}
                  undoDisabled={draft.historyBlocked}
                  onUndo={onUndo}
                  onRedo={onRedo}
                  applicationHref={releases.openHref}
                  install={releases.install}
                  onInstall={onInstall}
                  installPending={releases.actionPending === "install"}
                  onPreview={onPreview}
                  previewPending={releases.previewPending}
                  previewDisabled={draft.locked}
                  onPublish={onPublish}
                  publishDisabled={draft.locked}
                  publishPending={releases.actionPending === "publish"}
                />
              }
              panel={
                <>
                  {structure.panel}
                  {canvas.panels}
                  {menuTheme.menuPanel}
                  {data.panel}
                  {flows.panel}
                  {menuTheme.themePanel}
                  {access.panel}
                </>
              }
              inspector={
                tab === "access" || tab === "releases"
                  ? null
                  : tab === "data"
                    ? data.inspector
                    : canvas.inspector
              }
              canvas={({ inspectorOpen, toggleInspector, focused, focusCanvas }) => (
                <>
                  {canvas.toolbar(
                    inspectorOpen,
                    toggleInspector,
                    centreTitle,
                    canvasShown,
                    focused,
                    focusCanvas,
                    draft.loadingView,
                  )}
                  {releases.flowHost.banner}
                  {draft.viewProblem !== null ? (
                    <div role="alert" className="px-4 py-2 text-sm">
                      {draft.viewProblem.message}{" "}
                      {draft.viewProblem.retry ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void draft.refreshView();
                          }}
                        >
                          Try again
                        </Button>
                      ) : null}
                    </div>
                  ) : draft.view.failure !== null ? (
                    <p role="alert" className="px-4 py-2 text-sm">
                      This draft cannot be published:{" "}
                      {describeStudioCompileFailure(draft.view.failure, draft.source).message}
                    </p>
                  ) : null}
                  <div
                    className={
                      canvasShown
                        ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                        : "min-h-0 flex-1 overflow-auto p-4"
                    }
                  >
                    {canvasShown && canvas.centre}
                    {tab === "flows" && flows.centre}
                    {tab === "data" && data.centre}
                    {tab === "access" && access.centre}
                    <div hidden={tab !== "releases"}>{releases.centre}</div>
                  </div>
                </>
              )}
            />
          </StudioPuckProvider>
          {canvas.dialog}
          {data.dialog}
          {releases.flowHost.element}
        </div>
      </StudioPlaceOpenerProvider>
    </StudioFieldProblemsProvider>
  );
}
