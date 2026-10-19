"use client";
import { useEffect, useMemo, useState } from "react";
import type { ImmutablePlatformBlockCatalogue } from "@vortex/platform/schema";
import {
  StudioFieldProblemsProvider,
  projectStudioSemanticOutline,
  studioSemanticSelectionKey,
  type StudioSemanticSelection,
  type StudioStoredApplicationDraft,
} from "@vortex/ui/studio";
import type { FieldInputControlReleaseMap, PlatformThemeTokens } from "@vortex/ui";
import { createStudioPlacementDescriber, studioOutlineLabels } from "../_lib/studio-labels";
import { studioPlaceSelection, studioTabOfSelection } from "../_lib/studio-places";
import { ApplicationDraftAgentTools } from "./application-draft-agent-tools";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import { NewApplicationWorkspace } from "./new-application-workspace";
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
import { StudioTopBar } from "./studio-top-bar";
import { StudioPlaceOpenerProvider, type StudioPlaceOpener } from "./studio-used-in";
import { useStudioCanvasTab } from "./use-studio-canvas-tab";
import { useStudioDraft } from "./use-studio-draft";
import { useStudioDraftTheme } from "./use-studio-draft-theme";
import { useStudioFlowsTab } from "./use-studio-flows-tab";
import { useStudioMenuThemeTabs } from "./use-studio-menu-theme-tabs";
import { useStudioReleasesTab } from "./use-studio-releases-tab";
import { useStudioStructureTab } from "./use-studio-structure-tab";
import {
  applyStudioAccessCommand,
  type StudioAccessCommand,
  type StudioAccessResult,
} from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import type { StudioStructureForm } from "./studio-structure-editor";

/** Where the workspace sits: the organisation it belongs to and the running application it builds. */
export type StudioWorkspacePlace = Readonly<{
  organizationName: string;
  /** The running application, for Back to app; absent when the organisation's address is unknown. */
  applicationHref: string | undefined;
  /** The App Store, where a published version is installed or upgraded to; absent like the above. */
  appStoreHref: string | undefined;
}>;

type WorkspaceProps =
  | Readonly<{
      mode: "new";
      organizationId: string;
      platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
      fieldInputControlReleases: FieldInputControlReleaseMap;
      platformThemeTokens: PlatformThemeTokens;
    }>
  | Readonly<{
      mode: "existing";
      organizationId: string;
      draft: StudioStoredApplicationDraft;
      place: StudioWorkspacePlace;
      initialTab?: string | undefined;
      initialSection?: string | undefined;
      initialModule?: string | undefined;
      applications: readonly StudioModuleOwnerApplication[];
      initialView: Parameters<typeof useStudioDraft>[0]["initialView"];
    }>;

type ExistingProps = Extract<WorkspaceProps, { mode: "existing" }>;

export function ApplicationDraftWorkspace(props: WorkspaceProps) {
  return props.mode === "new" ? (
    <NewApplicationWorkspace
      organizationId={props.organizationId}
      catalogue={props.platformBlockCatalogue}
    />
  ) : (
    <ExistingApplicationWorkspace {...props} />
  );
}

/**
 * The one Studio workspace for an existing application. It only composes: the draft store (history,
 * one selection, autosave and the compiled view) and one controller per rail tab, each editing the
 * draft through the store's single command envelope.
 */
function ExistingApplicationWorkspace(props: ExistingProps) {
  const { organizationId, place, applications } = props;
  const [tab, setTab] = useState<StudioRailKey>(
    isStudioRailKey(props.initialTab) ? props.initialTab : "structure",
  );
  const [structureForm, setStructureForm] = useState<StudioStructureForm>("none");
  const draft = useStudioDraft({
    organizationId,
    draft: props.draft,
    tab,
    creation:
      structureForm === "shell" ? "layout" : structureForm === "record" ? "record_page" : undefined,
    initialView: props.initialView,
  });
  const catalogue = draft.view.catalogue;
  // Every way of opening a tab shares this state, including rule links and the rail.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === tab) return;
    url.searchParams.set("tab", tab);
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
  const openIn = (nextTab: StudioRailKey, next: StudioSemanticSelection) => {
    setTab(nextTab);
    draft.select(next);
  };

  // The one outline of the draft: Structure, Outline and every label Studio shows are views of it.
  const describePlacement = useMemo(() => createStudioPlacementDescriber(catalogue), [catalogue]);
  const outline = useMemo(
    () =>
      projectStudioSemanticOutline({ rootId: state.rootId, source, catalogue }, describePlacement),
    [state.rootId, source, catalogue, describePlacement],
  );
  const labels = useMemo(() => studioOutlineLabels(outline), [outline]);
  // Every "Used in" entry and "Show me where" link opens its place in its own tab, selected.
  const placeOpener: StudioPlaceOpener = {
    open: (where) => {
      const next = studioPlaceSelection(where.open, state.rootId);
      if (next === null) return;
      // The Access tab may be showing another of its views while the role is already selected.
      if (next.kind === "role") access.showRole();
      openIn(studioTabOfSelection(next), next);
    },
    nameOf: (where) => {
      const next = studioPlaceSelection(where.open, state.rootId);
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
    openFlowsTab: () => setTab("flows"),
  });
  const canvas = useStudioCanvasTab({
    draft,
    tab,
    catalogue,
    fieldInputControlReleases: draft.view.fieldInputControlReleases,
    platformThemeTokens: draft.view.platformThemeTokens,
    outline,
    labels,
    theme,
    flowsInspector: flows.inspector,
    placementWorkflows: flows.placementWorkflows,
    applications,
    openTab: setTab,
  });

  // The Access tab's one edit path, the same envelope as every other tab.
  const commandAccess = (command: StudioAccessCommand, merge?: string): StudioAccessResult => {
    const outcome = draft.run<StudioAccessResult>(
      (current) => {
        const result = applyStudioAccessCommand(current, command);
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
  const openAccessPages = () => {
    access.showPages();
    setTab("access");
  };
  const structure = useStudioStructureTab({
    draft,
    catalogue,
    describePlacement,
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
    hidden: tab !== "data",
    compositionContext: canvas.compositionContext,
    readRecords: canvas.readRecordChoices,
  });
  const releases = useStudioReleasesTab({
    draft,
    hidden: tab !== "releases",
    initialSection: isStudioReleasesSection(props.initialSection)
      ? props.initialSection
      : ("history" as StudioReleasesSection),
    appStoreHref: place.appStoreHref,
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
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "z")
        return;
      event.preventDefault();
      // A modal owns its actions. Also prevent native Undo reaching the previously focused input.
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]'))
        return;
      if (event.shiftKey) draft.redo();
      else draft.undo();
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [draft]);

  return (
    <StudioFieldProblemsProvider>
      <StudioPlaceOpenerProvider opener={placeOpener}>
        <div aria-busy={draft.isHeld("publication") || draft.isHeld("reopening")}>
          <ApplicationDraftAgentTools
            draft={draft}
            command={canvas.commandComposition}
            readQueries={canvas.readQueries}
            {...releases.agent}
          />
          <StudioFrame
            tabs={studioRailTabs}
            activeTab={tab}
            onTabChange={setTab}
            selectionKey={draft.selected === null ? "" : studioSemanticSelectionKey(draft.selected)}
            topBar={
              <StudioTopBar
                location={{
                  organizationName: place.organizationName,
                  organizationHref: `/studio/${encodeURIComponent(organizationId)}`,
                  applicationName: source.body.name,
                  item: tab === "releases" ? releases.title : canvas.breadcrumbItem,
                  applications: applications.map((app) => ({
                    name: app.name,
                    href: `/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(app.rootId)}`,
                  })),
                  onApplication: () => {
                    draft.select({ kind: "application", applicationRootId: state.rootId });
                  },
                }}
                saveState={<StudioSaveState draft={draft} />}
                canUndo={state.canUndo}
                canRedo={state.canRedo}
                undoDisabled={draft.locked}
                onUndo={draft.undo}
                onRedo={draft.redo}
                backToAppHref={place.applicationHref}
                onPreview={releases.openPreview}
                previewPending={releases.previewPending}
                previewDisabled={draft.locked}
                onPublish={releases.openPublish}
                publishDisabled={draft.locked}
              />
            }
            panel={
              <>
                {structure.panel}
                {canvas.panels}
                {menuTheme.menuPanel}
                {data.panel}
                {flows.panel(tab !== "flows")}
                {menuTheme.themePanel}
                {access.panel}
                {releases.panel}
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
                )}
                {draft.viewProblem !== "" ? (
                  <div role="alert" className="px-4 py-2 text-sm">
                    {draft.viewProblem}{" "}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void draft.refreshView();
                      }}
                    >
                      Try again
                    </Button>
                  </div>
                ) : draft.loadingView ? (
                  <p role="status" className="px-4 py-2 text-sm">
                    Loading this editor…
                  </p>
                ) : null}
                <div
                  className={
                    canvasShown
                      ? "min-h-0 flex-1 overflow-auto"
                      : "min-h-0 flex-1 overflow-auto p-4"
                  }
                >
                  {canvasShown && canvas.centre}
                  {tab === "flows" && flows.centre}
                  {/* The Data tab's centre keeps its paging and reads while another tab is open. */}
                  <div hidden={tab !== "data"}>{data.centre}</div>
                  {tab === "access" && access.centre}
                  <div hidden={tab !== "releases"}>{releases.centre}</div>
                </div>
              </>
            )}
          />
          {releases.dialog}
          {canvas.dialog}
          {data.dialog}
        </div>
      </StudioPlaceOpenerProvider>
    </StudioFieldProblemsProvider>
  );
}
