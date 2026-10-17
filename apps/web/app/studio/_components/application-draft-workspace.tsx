"use client";
import { useMemo, useState } from "react";
import type { ImmutablePlatformBlockCatalogue, PeopleDirectoryOwner } from "@vortex/platform/schema";
import {
  projectStudioSemanticOutline,
  type StudioBorrowedChoices, type StudioCompileFailure, type StudioSemanticSelection, type StudioStoredApplicationDraft,
} from "@vortex/ui/studio";
import type { FieldInputControlReleaseMap, PlatformThemeTokens } from "@vortex/ui";
import type { StudioApplicationCanvasFrames, StudioApplicationCompiledPageSlots } from "../../_lib/studio-application-draft";
import type { StudioCompiledFields, StudioDataModule, StudioPublishedData } from "../_lib/studio-data-model";
import type { StudioThemeOptions } from "../_lib/studio-theme-options";
import { createStudioPlacementDescriber, studioOutlineLabels } from "../_lib/studio-labels";
import { ApplicationDraftAgentTools } from "./application-draft-agent-tools";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import { NewApplicationWorkspace } from "./new-application-workspace";
import { useStudioAccessTab } from "./studio-access-tab";
import { useStudioDataTab } from "./studio-data-tab";
import { StudioFrame } from "./studio-frame";
import {
  isStudioRailKey, isStudioReleasesSection, railShowsCanvas, studioRailTabs, type StudioRailKey, type StudioReleasesSection,
} from "./studio-rail-tabs";
import { StudioSaveProblem } from "./studio-save-problem";
import { StudioTopBar } from "./studio-top-bar";
import { useStudioCanvasTab } from "./use-studio-canvas-tab";
import { useStudioDraft } from "./use-studio-draft";
import { useStudioDraftTheme } from "./use-studio-draft-theme";
import { useStudioFlowsTab } from "./use-studio-flows-tab";
import { useStudioMenuThemeTabs } from "./use-studio-menu-theme-tabs";
import { useStudioReleasesTab } from "./use-studio-releases-tab";
import { useStudioStructureTab } from "./use-studio-structure-tab";
import { applyStudioAccessCommand, type StudioAccessCommand, type StudioAccessResult } from "@vortex/ui/studio";

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
      /** The compiled fields of the saved draft, for a query filter's typed controls. */
      compiledFields?: StudioCompiledFields | null;
      borrowedChoices?: StudioBorrowedChoices | null;
      /** The modules the application uses, read-only in the Data tab. */
      usedModules?: readonly StudioDataModule[] | null;
      /** What the published versions of its own modules hold, whose stored shape is fixed. */
      published?: StudioPublishedData | null;
      /** The organisation's people directory, which a Person link points at. */
      peopleDirectory?: PeopleDirectoryOwner | null;
      pageCompiledSlots?: StudioApplicationCompiledPageSlots | null;
      canvasFrames?: StudioApplicationCanvasFrames | null;
      compileFailure?: StudioCompileFailure | null }>);

type ExistingProps = Extract<WorkspaceProps, { mode: "existing" }>;

export function ApplicationDraftWorkspace(props: WorkspaceProps) {
  return props.mode === "new"
    ? <NewApplicationWorkspace organizationId={props.organizationId} />
    : <ExistingApplicationWorkspace {...props} />;
}

/**
 * The one Studio workspace for an existing application. It only composes: the draft store (history,
 * one selection, autosave and the compiled view) and one controller per rail tab, each editing the
 * draft through the store's single command envelope.
 */
function ExistingApplicationWorkspace(props: ExistingProps) {
  const { organizationId, place, platformBlockCatalogue: catalogue, applications } = props;
  const draft = useStudioDraft({ organizationId, draft: props.draft, catalogue, initialView: {
    slots: props.pageCompiledSlots ?? null, frames: props.canvasFrames ?? null, failure: props.compileFailure ?? null,
    compiledFields: props.compiledFields ?? null, borrowedChoices: props.borrowedChoices ?? null,
    usedModules: props.usedModules ?? null, published: props.published ?? null, peopleDirectory: props.peopleDirectory ?? null,
  } });
  const [tab, setTab] = useState<StudioRailKey>(isStudioRailKey(props.initialTab) ? props.initialTab : "structure");
  const { source, state } = draft;
  const openIn = (nextTab: StudioRailKey, next: StudioSemanticSelection) => { setTab(nextTab); draft.select(next); };

  // The one outline of the draft: Structure, Outline and every label Studio shows are views of it.
  const describePlacement = useMemo(() => createStudioPlacementDescriber(catalogue), [catalogue]);
  const outline = useMemo(() => projectStudioSemanticOutline({ rootId: state.rootId, source, catalogue }, describePlacement),
    [state.rootId, source, catalogue, describePlacement]);
  const labels = useMemo(() => studioOutlineLabels(outline), [outline]);
  const theme = useStudioDraftTheme({ organizationId, rootId: state.rootId, theme: source.body.theme,
    compiledTheme: draft.view.frames?.theme, compiledSourceTheme: draft.view.source.body.theme });

  const flows = useStudioFlowsTab({ draft, catalogue, labels, applications, openFlowsTab: () => setTab("flows") });
  const canvas = useStudioCanvasTab({ draft, tab, catalogue, fieldInputControlReleases: props.fieldInputControlReleases,
    platformThemeTokens: props.platformThemeTokens, outline, labels, theme, flowsInspector: flows.inspector,
    placementWorkflows: flows.placementWorkflows, openTab: setTab });

  // The Access tab's one edit path, the same envelope as every other tab.
  const commandAccess = (command: StudioAccessCommand, merge?: string): StudioAccessResult => {
    const outcome = draft.run<StudioAccessResult>((current) => {
      const result = applyStudioAccessCommand(current, command);
      return result.kind === "applied" ? { kind: "edit", source: result.source, result } : { kind: "keep", result };
    }, { merge });
    return outcome.kind === "blocked" ? { kind: "refused", message: outcome.message } : outcome.result;
  };
  const access = useStudioAccessTab({ source, selected: draft.selected, select: draft.select,
    compiledRoles: draft.view.frames?.roles, hidden: tab !== "access", disabled: draft.locked,
    onCommand: commandAccess, onPreview: canvas.previewAs,
    goTo: (where) => where.kind === "page" ? openIn("structure", { kind: "page", pageAlias: where.pageAlias })
      : where.kind === "navigation" ? openIn("menu", { kind: "navigation", navigationItemAlias: where.alias })
        : where.kind === "placement" ? openIn("structure", { kind: "placement", placementAlias: where.placementAlias })
          : openIn("data", { kind: "module", moduleKey: where.moduleKey }) });
  const openAccessPages = () => { access.showPages(); setTab("access"); };
  const structure = useStudioStructureTab({ draft, catalogue, describePlacement, outline, hidden: tab !== "structure", openAccessPages });
  const menuTheme = useStudioMenuThemeTabs({ draft, menuHidden: tab !== "menu", themeHidden: tab !== "theme",
    themeOptions: props.themeOptions, theme, openAccessPages });
  const data = useStudioDataTab({ draft, applications, initialModule: props.initialModule ?? null, hidden: tab !== "data",
    compositionContext: canvas.compositionContext, readRecords: canvas.readRecordChoices, openInTab: openIn });
  const releases = useStudioReleasesTab({ draft, hidden: tab !== "releases",
    initialSection: isStudioReleasesSection(props.initialSection) ? props.initialSection : "history" as StudioReleasesSection,
    blocked: canvas.publishBlocked });

  const centreTitle = tab === "data" ? data.title : tab === "access" ? access.title : tab === "releases" ? releases.title : canvas.title;
  const canvasShown = railShowsCanvas(tab);
  const conflictLoading = draft.isHeld("reopening");

  return <div aria-busy={draft.isHeld("publication") || draft.isHeld("reopening")}>
    <ApplicationDraftAgentTools draft={draft} catalogue={catalogue} command={canvas.commandComposition}
      readQueries={canvas.readQueries} {...releases.agent} />
    <StudioFrame tabs={studioRailTabs} activeTab={tab} onTabChange={setTab}
      topBar={<StudioTopBar
        location={{ organizationName: place.organizationName, organizationHref: `/studio/${encodeURIComponent(organizationId)}`,
          applicationName: source.body.name, item: canvas.breadcrumbItem,
          onApplication: () => { draft.select({ kind: "application", applicationRootId: state.rootId }); } }}
        chip={draft.chip} chipAlert={draft.status.kind === "conflict" || draft.status.kind === "refused"}
        status={releases.notice}
        problem={<StudioSaveProblem status={draft.status} loading={conflictLoading} onLoadLatest={() => { void draft.reload(); }} />}
        canUndo={state.canUndo} canRedo={state.canRedo} undoDisabled={draft.locked}
        onUndo={draft.undo} onRedo={draft.redo}
        backToAppHref={place.applicationHref}
        onPreview={releases.openPreview} previewPending={releases.previewPending} previewDisabled={draft.locked}
        onPublish={releases.openPublish} publishDisabled={draft.locked} />}
      panel={<>
        {structure.panel}
        {canvas.panels}
        {menuTheme.menuPanel}
        {data.panel}
        {flows.panel(tab !== "flows")}
        {menuTheme.themePanel}
        {access.panel}
        {releases.panel}
      </>}
      inspector={tab === "data" ? data.inspector : canvas.inspector}
      canvas={({ inspectorOpen, toggleInspector }) => <>
        {canvas.toolbar(inspectorOpen, toggleInspector, centreTitle, canvasShown)}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {canvasShown && canvas.centre}
          {tab === "flows" && flows.centre}
          {/* The Data tab's centre keeps its paging and reads while another tab is open. */}
          <div hidden={tab !== "data"}>{data.centre}</div>
          {tab === "access" && access.centre}
          <div hidden={tab !== "releases"}>{releases.centre}</div>
        </div>
      </>} />
    {releases.dialog}
    {canvas.dialog}
    {data.dialog}
  </div>;
}
