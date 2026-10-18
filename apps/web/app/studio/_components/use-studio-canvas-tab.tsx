"use client";
import dynamic from "next/dynamic";
import { Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applicationSourceDocumentSchema, holdsPermission,
  type ApplicationSourceDocument, type ImmutablePlatformBlockCatalogue, type NavigationPermissionDecisions,
} from "@vortex/platform/schema";
import {
  applyStudioCompositionCommand, applyStudioVisibilityCondition, describeStudioCompositionAddTargets, studioDraftChoices,
  resolveStudioSelectionInspectorContext, studioSemanticSelectionKey, traverseStudioSemanticSelectionDraft,
  type StudioCompositionCommand, type StudioCompositionContext, type StudioCompositionDestination,
  type StudioCompositionOutcome, type StudioRecordReader, type StudioSemanticOutline, type StudioSemanticSelection,
} from "@vortex/ui/studio";
import { createAppearanceRootProps, Icon, type FieldInputControlReleaseMap, type PlatformThemeTokens } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import type { StudioCanvasAddRequest, StudioCanvasBreakpoint, StudioCanvasFrame } from "@vortex/ui/studio/page-puck-editor";
import { FirstRecordTypeEmptyState } from "../../_components/first-record-type-empty-state";
import { readStudioCanvasRecords, readStudioDataRecords } from "../actions";
import { applyStudioItemLabels } from "@vortex/ui/studio";
import { studioDraftNavigation } from "../_lib/studio-draft-navigation";
import { studioUseTargetOf } from "../_lib/studio-places";
import type { StudioApplicationCanvasFrames } from "../../_lib/studio-application-draft";
import { studioMenuPosition } from "@vortex/ui/studio";
import { ApplicationCompositionEditor } from "./application-composition-editor";
import { ApplicationVisibilityConditionEditor } from "./application-visibility-condition-editor";
import { StudioBlockSetupDialog, type StudioBlockSetupRequest } from "./studio-block-setup-dialog";
import { StudioCanvasToolbar, type StudioCanvasZoom } from "./studio-canvas-toolbar";
import { StudioPanelShell } from "./studio-frame";
import { StudioInspector } from "./studio-inspector";
import { StudioUsedIn } from "./studio-used-in";
import { StudioBlockOutlinePanel } from "./studio-outline-panels";
import type { StudioRailKey } from "./studio-rail-tabs";
import type { StudioDraft } from "./use-studio-draft";
import type { useStudioDraftTheme } from "./use-studio-draft-theme";

// The Puck editor is the heaviest Studio dependency; load it only when a page is selected.
const ApplicationPagePuckEditor = dynamic(
  () => import("@vortex/ui/studio/page-puck-editor").then((module) => module.ApplicationPagePuckEditor),
  { ssr: false });

/**
 * The application frame the canvas draws the page inside: the compiled draft's shell, with the
 * draft's menu and theme as they are edited, so Menu and Theme changes show before a compile. The
 * menu is the one a previewed role sees, or every entry in the design view (`decisions` null).
 */
const canvasFrameFor = (frames: StudioApplicationCanvasFrames | null, pageAlias: string,
  source: ApplicationSourceDocument, theme: StudioCanvasFrame["theme"] | undefined,
  decisions: NavigationPermissionDecisions | null): StudioCanvasFrame | undefined => {
  const page = frames?.pages[pageAlias];
  return frames === null || page === undefined || theme === undefined ? undefined : {
    applicationName: frames.applicationName, shells: frames.shells,
    theme, navigation: studioDraftNavigation(source, frames.pages, decisions), ...page,
  };
};

const sameDestination = (left: StudioCompositionDestination, right: StudioCompositionDestination) =>
  left.kind === "root" ? right.kind === "root"
    : right.kind === "child" && left.parentAlias === right.parentAlias && left.slotKey === right.slotKey;

/**
 * The page canvas and what edits it: the Blocks and Outline panels, the inspector (name, settings,
 * order and size, visibility rule and workflows of the selection), the Puck canvas itself and its
 * toolbar, and "Who can see this". Every edit is one command through the draft's envelope.
 */
export function useStudioCanvasTab({ draft, tab, catalogue, fieldInputControlReleases, platformThemeTokens, outline, labels,
  theme, flowsInspector, placementWorkflows, openTab }: Readonly<{
  draft: StudioDraft;
  tab: StudioRailKey;
  catalogue: ImmutablePlatformBlockCatalogue;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  outline: StudioSemanticOutline;
  /** Selection key to the label Studio shows for it. */
  labels: ReadonlyMap<string, string>;
  theme: ReturnType<typeof useStudioDraftTheme>;
  /** The selected flow step's inspector, from the Flows tab. */
  flowsInspector: ReactNode;
  /** The selected block's workflows, from the Flows tab. */
  placementWorkflows: ReactNode;
  openTab: (tab: StudioRailKey) => void;
}>) {
  const { organizationId, source, selected, state, view } = draft;
  const rootId = state.rootId;
  const key = draft.saved.key;
  const [canvasZoom, setCanvasZoom] = useState<StudioCanvasZoom>(100);
  const [breakpoint, setBreakpoint] = useState<StudioCanvasBreakpoint>("desktop");
  // The canvas previews the application in light or dark; the running application keeps its own toggle.
  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  // "Who can see this": the role the canvas and its menu are previewed as; null is the builder's view.
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [paletteHost, setPaletteHost] = useState<HTMLElement | null>(null);
  const [paletteMessage, setPaletteMessage] = useState("");
  const [blockSetup, setBlockSetup] = useState<StudioBlockSetupRequest | null>(null);
  const [notice, setNotice] = useState("");

  const inspector = resolveStudioSelectionInspectorContext({ rootId, source }, selected);
  const selectionKey = selected === null ? "" : studioSemanticSelectionKey(selected);
  // The page or layout that holds each block: the canvas draws a block's page, the Outline lists its owner's blocks.
  const placementOwners = useMemo(() => {
    const owners = new Map<string, Readonly<{ kind: "page"; pageAlias: string } | { kind: "shell"; shellAlias: string }>>();
    traverseStudioSemanticSelectionDraft({ rootId, source, catalogue }, ({ phase, node }) => {
      if (phase === "enter" && node.kind === "placement")
        owners.set(node.selection.placementAlias, node.owner.kind === "page"
          ? { kind: "page", pageAlias: node.owner.pageAlias } : { kind: "shell", shellAlias: node.owner.shellAlias });
    });
    return owners;
  }, [rootId, source, catalogue]);
  const selectedOwner = selected?.kind === "placement" ? placementOwners.get(selected.placementAlias) : undefined;
  // A menu entry shows the page it opens; the Menu and Theme tabs otherwise show the home page, so
  // their changes are seen in the application's frame.
  const selectedEntry = selected?.kind === "navigation" ? studioMenuPosition(source, selected.navigationItemAlias)?.item : undefined;
  const pageAliasOfKey = (pageKey: string | undefined) => source.body.pages.find((page) => page.key === pageKey)?.id;
  const canvasPageAlias = selected?.kind === "page" ? selected.pageAlias
    : selectedOwner?.kind === "page" ? selectedOwner.pageAlias
      : selectedEntry?.type === "page" ? pageAliasOfKey(selectedEntry.page) ?? pageAliasOfKey(source.body.home_page)
        : tab === "menu" || tab === "theme" ? pageAliasOfKey(source.body.home_page) : undefined;
  const canvasPage = canvasPageAlias === undefined ? undefined : source.body.pages.find((page) => page.id === canvasPageAlias);
  const canvasPageRef = useRef(canvasPage?.id);
  canvasPageRef.current = canvasPage?.id;
  // A previewed role holds what the compiled saved draft grants it, which is what the running application installs.
  const viewAsGrants = viewAs === null ? undefined : view.frames?.roles[viewAs];
  const viewAsRole = viewAsGrants === undefined ? undefined : source.body.roles.find((role) => role.key === viewAs);
  const viewDecisions = useMemo<NavigationPermissionDecisions | null>(() => viewAsGrants === undefined ? null
    : Object.fromEntries(viewAsGrants.map((grant) => [grant, true])), [viewAsGrants]);

  const compositionContext = useMemo<StudioCompositionContext>(() => ({
    organizationId, rootId, key, draftRevision: state.draftRevision, localLifetime: draft.lifetime, catalogue, source: state.source,
  }), [organizationId, rootId, key, state.draftRevision, draft.lifetime, catalogue, state.source]);
  const liveContext = (): StudioCompositionContext => {
    const current = draft.history.getState();
    return { organizationId, rootId: current.rootId, key, draftRevision: current.draftRevision, localLifetime: draft.lifetime,
      catalogue, source: current.source };
  };

  // The one composition edit: the item editor's controls, the Data tab's placements and the agent tools all come through here.
  const commandComposition = (expected: StudioCompositionContext, expectedSelection: StudioSemanticSelection,
    command: StudioCompositionCommand, merge?: string): StudioCompositionOutcome => {
    const now = draft.selection.getSelection();
    if (now === null || studioSemanticSelectionKey(now) !== studioSemanticSelectionKey(expectedSelection)) return { kind: "stale" };
    const outcome = draft.run((): { kind: "edit"; source: ApplicationSourceDocument; result: StudioCompositionOutcome }
      | { kind: "keep"; result: StudioCompositionOutcome } => {
      const result = applyStudioCompositionCommand(liveContext(), expected, now, command);
      return result.kind === "applied" ? { kind: "edit", source: result.source, result: { kind: "applied" } }
        : { kind: "keep", result: result.kind === "refused" ? { kind: "refused", reason: result.reason } : { kind: result.kind } };
    }, { merge });
    return outcome.kind === "done" ? outcome.result : { kind: "refused", reason: outcome.message };
  };

  // The one add path for a new block: a drop on the canvas, the palette's Add button and the setup dialog.
  const runAdd = (command: Extract<StudioCompositionCommand, { kind: "add" }>): string | true => {
    const after: { added?: string | undefined } = {};
    const outcome = draft.run((): { kind: "edit"; source: ApplicationSourceDocument; result: string | true }
      | { kind: "keep"; result: string | true } => {
      const context = liveContext();
      const result = applyStudioCompositionCommand(context, context, draft.selection.getSelection(), command);
      if (result.kind === "refused") return { kind: "keep", result: result.reason };
      if (result.kind !== "applied") {
        console.error(`[studio] adding a block was refused: STUDIO_ADD_${result.kind.toUpperCase()}`);
        return { kind: "keep", result: "The block could not be added, so the draft is unchanged." };
      }
      after.added = result.placementAlias;
      return { kind: "edit", source: result.source, result: true };
    });
    if (outcome.kind === "blocked") return outcome.message;
    if (outcome.result === true && after.added !== undefined) draft.select({ kind: "placement", placementAlias: after.added });
    return outcome.result;
  };
  const addTargets = useMemo(() => canvasPage === undefined ? null
    : describeStudioCompositionAddTargets(compositionContext, canvasPage.id), [compositionContext, canvasPage?.id]);
  // A block for one place: added at once, or after its setup when it needs settings or data.
  const addBlock = (request: StudioCanvasAddRequest): boolean => {
    const pageAlias = canvasPageRef.current;
    if (pageAlias === undefined || addTargets?.kind !== "available") return false;
    const target = addTargets.targets.find((candidate) => candidate.area === request.area &&
      sameDestination(candidate.destination, request.destination));
    const choice = target?.choices.find((candidate) => candidate.rendererKey === request.rendererKey);
    // A block this place does not admit still goes to the add command, which names why it is refused.
    const release = choice ?? [...catalogue.releases].reverse().find((candidate) => candidate.rendererKey === request.rendererKey);
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
          if (outcome === true) setPaletteMessage(`${choice.name} added.`);
          return outcome;
        } });
      return false;
    }
    const outcome = runAdd({ ...command, settings: {}, query: null });
    setPaletteMessage(outcome === true ? `${release.name} added.` : outcome);
    return outcome === true;
  };

  // A drag on the canvas: the canvas edits the draft it was drawn from, so any change in between makes it stale.
  const applyPuckPageEdit = (expectedSource: ApplicationSourceDocument, nextSource: ApplicationSourceDocument) => {
    if (canvasPageRef.current === undefined) return;
    const parsed = applicationSourceDocumentSchema.safeParse(nextSource);
    if (!parsed.success) {
      console.error("Failed to validate Puck page changes", parsed.error);
      setNotice("This page change could not be applied. Your draft is unchanged.");
      return;
    }
    if (parsed.data.key !== key || parsed.data.root_alias !== state.source.root_alias) return;
    const outcome = draft.run(() => ({ kind: "edit", source: parsed.data, result: true }), { expected: expectedSource });
    setNotice(outcome.kind === "blocked" ? outcome.message : "");
  };

  // What reference settings and the query picker offer: queries that already exist (own, then borrowed), fields and pages.
  // A record reference picks a record of the builder's preview of the saved draft, read 40 at a
  // time with their preview access through the same reader as the Data tab's results.
  const readRecordChoices = useCallback<StudioRecordReader>(async ({ recordType, after }) => {
    const separator = recordType.indexOf(":");
    const result = await readStudioDataRecords(organizationId, { rootId, draftRevision: view.draftRevision,
      moduleKey: recordType.slice(0, separator), recordKey: recordType.slice(separator + 1), pageSize: 40,
      ...(after === undefined ? {} : { continuationToken: after }) });
    switch (result.kind) {
      case "available": {
        const title = result.titleColumn;
        return { kind: "available", records: result.rows.map((row) => ({ recordId: row.id,
          label: (title === undefined ? undefined : row.cells[title]) || "Untitled record" })),
          ...(result.next === undefined ? {} : { next: result.next }) };
      }
      case "not_saved": return { kind: "not_saved" };
      // The preview is still moving to the saved revision; the picker reads again when opened again.
      case "following": return { kind: "temporarily_unavailable" };
      // The saved draft moved on; the next save's revision reads again.
      case "conflict": return { kind: "temporarily_unavailable" };
      case "no_query": return { kind: "no_list" };
      // A record type is read through a plain query, never a summary.
      case "summary": return { kind: "no_list" };
      case "query_refused":
        console.error(`[studio] record choices were refused: STUDIO_RECORD_CHOICES_REFUSED reason=${result.reason}`);
        return { kind: "refused" };
      case "refused": return { kind: "refused" };
      case "temporarily_unavailable": return { kind: "temporarily_unavailable" };
    }
  }, [organizationId, rootId, view.draftRevision]);
  const draftChoices = useMemo(() => studioDraftChoices(source, view.borrowedChoices, readRecordChoices),
    [source, view.borrowedChoices, readRecordChoices]);
  // The records of the canvas's data blocks, read for the compiled saved revision only.
  const readCanvasRecords = useCallback(async (area: string) => {
    const pageAlias = canvasPageRef.current;
    if (pageAlias === undefined) return { state: "unavailable" as const, records: {} };
    const result = await readStudioCanvasRecords(organizationId, { rootId,
      draftRevision: view.draftRevision, sourceFingerprint: view.sourceFingerprint, pageAlias, area });
    if (result.kind === "available" && result.draftRevision === view.draftRevision &&
      result.sourceFingerprint === view.sourceFingerprint && result.pageAlias === pageAlias && result.area === area)
      return { state: "ready" as const, records: result.records, behind: result.behind,
        ...(result.sample === undefined ? {} : { sample: result.sample }) };
    if (result.kind === "refused") return { state: "refused" as const, records: {} };
    // A conflict means a newer save replaced this revision, whose own read follows; anything else is a failure.
    if (result.kind !== "conflict")
      console.error(`[studio] the canvas records were not read: STUDIO_CANVAS_RECORDS_${result.kind.toUpperCase()}`);
    // A newer save or the preview moving under this read: the canvas reads again shortly.
    return { state: "unavailable" as const, records: {}, behind: true };
  }, [organizationId, rootId, view.draftRevision, view.sourceFingerprint]);

  const commandVisibility: Parameters<typeof ApplicationVisibilityConditionEditor>[0]["onCommand"] =
    (expected, expectedSelection, metadata, condition) => {
      const currentSelection = draft.selection.getSelection();
      if (currentSelection?.kind !== "placement" || expectedSelection.kind !== "placement" ||
        currentSelection.placementAlias !== expectedSelection.placementAlias) return { kind: "stale" };
      const outcome = draft.run((): { kind: "edit"; source: ApplicationSourceDocument; result: ReturnType<typeof applyStudioVisibilityCondition> }
        | { kind: "keep"; result: ReturnType<typeof applyStudioVisibilityCondition> } => {
        const result = applyStudioVisibilityCondition(expected, liveContext(), currentSelection, metadata, condition);
        return result.kind === "applied" ? { kind: "edit", source: result.source, result } : { kind: "keep", result };
      }, { merge: `visibility:${currentSelection.placementAlias}` });
      return outcome.kind === "done" ? outcome.result : { kind: "stale" };
    };

  // The application's and a page's name and description, typed straight into the draft.
  const selectedPage = selected?.kind === "page" ? source.body.pages.find((page) => page.id === selected.pageAlias) : undefined;
  const editable = inspector.status === "resolved" && (selected?.kind === "application" || selectedPage !== undefined);
  const setLabels = (name: string, description: string): string | true => {
    const outcome = draft.run<string | true>((current) => {
      const applied = applyStudioItemLabels(current, draft.selection.getSelection(), name, description);
      return applied.kind === "applied" ? { kind: "edit", source: applied.source, result: true as const }
        : { kind: "keep", result: applied.kind === "invalid" ? "Enter a name and description within their length limits." : "This item is not in the draft any more." };
    }, { merge: `labels:${selectionKey}` });
    return outcome.kind === "blocked" ? outcome.message : outcome.result;
  };

  const previewAs = (roleKey: string) => {
    const role = source.body.roles.find((entry) => entry.key === roleKey);
    if (role === undefined || view.frames?.roles[roleKey] === undefined) {
      setNotice("The preview shows a role as the saved draft grants it; wait a moment for your latest change to save.");
      return;
    }
    setViewAs(roleKey);
    const start = source.body.pages.find((page) => page.key === role.home_page);
    if (start === undefined) return;
    openTab("structure");
    draft.select({ kind: "page", pageAlias: start.id });
  };

  const pageLabel = (pageAlias: string, fallback: string) => labels.get(studioSemanticSelectionKey({ kind: "page", pageAlias })) ?? fallback;
  // The layout open in Outline: selected directly, or the layout that holds the selected block.
  const ownerShellKey = selected?.kind === "shell" ? selectionKey
    : selectedOwner?.kind === "shell" ? studioSemanticSelectionKey(selectedOwner) : undefined;
  const breadcrumbItem = canvasPage !== undefined ? pageLabel(canvasPage.id, canvasPage.name)
    : ownerShellKey === undefined ? undefined : labels.get(ownerShellKey);
  const outlineOwnerKey = canvasPage !== undefined ? studioSemanticSelectionKey({ kind: "page", pageAlias: canvasPage.id }) : ownerShellKey;
  const selectedName = selected === null ? undefined : labels.get(selectionKey);
  const usedIn = studioUseTargetOf(selected);
  const title = canvasPage !== undefined ? pageLabel(canvasPage.id, canvasPage.name)
    : inspector.status === "resolved" ? selectedName ?? inspector.descriptor.label : "Select an item";
  const outlinePanelProps = { outline, selectedKey: selectionKey, disabled: draft.isHeld("publication"),
    choose: (node: { selection: StudioSemanticSelection | null }) => { if (node.selection !== null) draft.select(node.selection); } };

  const panels = <>
    <StudioBlockOutlinePanel {...outlinePanelProps} hidden={tab !== "outline"} ownerKey={outlineOwnerKey} />
    <StudioPanelShell title="Blocks" description="Blocks to add to the page on the canvas." hidden={tab !== "blocks"}>
      {/* The canvas's editor draws the palette here, so its blocks drag with the canvas's own drag and drop. */}
      <div ref={setPaletteHost} />
      {canvasPage === undefined && <p className="text-sm text-muted-foreground">Choose a page in Structure to add blocks to it.</p>}
    </StudioPanelShell>
  </>;

  const inspectorPanel = <StudioInspector inspector={inspector} labelsKey={selectionKey}
    title={inspector.status === "resolved" ? selectedName ?? inspector.descriptor.label : ""}
    labels={editable ? {
      isApplication: selected?.kind === "application",
      label: selected?.kind === "application" ? source.body.name : selectedPage?.name ?? "",
      description: source.body.description, disabled: draft.locked,
      onLabel: (value) => setLabels(value, source.body.description),
      onDescription: (value) => setLabels(selected?.kind === "application" ? source.body.name : selectedPage?.name ?? "", value),
    } : undefined}
    note={selected?.kind === "placement" ? undefined : selected?.kind === "flow" || selected?.kind === "flow_step"
      ? tab === "flows" ? undefined : "Open this flow in the Flows tab to change it."
      : selected === null ? undefined : selected.kind === "navigation" ? "Change this menu entry in the Menu tab."
        : selected.kind === "role" ? (tab === "access" ? undefined : "Change this role in the Access tab.")
        : selected.kind === "module" || selected.kind === "record_type" || selected.kind === "field" || selected.kind === "query"
          ? "Change this in the Data tab." : "This item cannot be edited here."}>
    {(selected?.kind === "flow" || selected?.kind === "flow_step") && tab === "flows" && inspector.status === "resolved" && flowsInspector}
    {selected?.kind === "placement" && inspector.status === "resolved" &&
      <ApplicationCompositionEditor key={selectionKey} context={compositionContext} selection={selected}
        disabled={draft.locked} choices={draftChoices} onCommand={commandComposition} />}
    {selected?.kind === "placement" && inspector.status === "resolved" &&
      <ApplicationVisibilityConditionEditor key={`${draft.lifetime}:${selectionKey}`} context={compositionContext}
        selection={selected} saved={draft.saved} disabled={draft.locked} onCommand={commandVisibility} />}
    {inspector.status === "resolved" && placementWorkflows}
    {usedIn !== null && <StudioUsedIn source={source} target={usedIn} name={selectedName ?? "it"} />}
  </StudioInspector>;

  const shown = canvasPage !== undefined && (inspector.status === "resolved" || selected === null);
  const centre = <section className={canvasPage !== undefined ? "space-y-3"
    : "space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground"} aria-label="Selected item">
    {notice !== "" && <p role="alert" className="text-sm text-destructive">{notice}</p>}
    {selected?.kind === "application" && <p>{source.body.description}</p>}
    {selected?.kind === "placement" && canvasPage === undefined && <p>This block is part of a layout. Change it in the inspector.</p>}
    {canvasPage === undefined && selected?.kind !== "flow" && selected?.kind !== "placement" &&
      <p className="text-sm text-muted-foreground">Choose a page in Structure to arrange it here.</p>}
    {(canvasPage === undefined ? selected?.kind === "application" : canvasPage.key === source.body.home_page) &&
      source.body.uses.length === 0 && source.body.modules.every((module) => module.record_types.length === 0) &&
      <FirstRecordTypeEmptyState action={<Button type="button" onClick={() => openTab("data")}>
        <Icon name="database" />Open the Data tab</Button>} />}
    {canvasPage !== undefined && theme.problem.length > 0 && <p role="alert" className="text-sm text-destructive">{theme.problem}</p>}
    {canvasPage !== undefined && viewAsRole !== undefined && viewDecisions !== null && <p role="status" className="text-sm text-muted-foreground">
      {holdsPermission(viewDecisions, canvasPage.permission) ? `Showing what ${viewAsRole.name} sees` : `${viewAsRole.name} cannot open this page; it is shown so you can keep working on it`}
      {draft.updatingCanvas ? ", as the saved draft grants it. Your latest change shows once the canvas is updated." : "."}</p>}
    {shown && canvasPage !== undefined &&
      // The canvas previews the application in light or dark: the appearance is set on the canvas only, never on Studio's frame.
      <div {...createAppearanceRootProps(appearance)} style={{ ...createAppearanceRootProps(appearance).style, zoom: canvasZoom / 100 }}>
        {/* A newly chosen icon library loads before the canvas draws with it; only the canvas waits. */}
        <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Drawing the canvas with the new theme…</p>}>
          <ApplicationPagePuckEditor key={`canvas:${canvasPage.id}`} source={source} compiledSource={view.source}
            platformBlockCatalogue={catalogue} fieldInputControlReleases={fieldInputControlReleases}
            platformThemeTokens={platformThemeTokens} pageAlias={canvasPage.id} compiledSlots={view.slots?.[canvasPage.id]}
            frame={canvasFrameFor(view.frames, canvasPage.id, source, theme.theme, viewDecisions)}
            viewer={viewAsRole === undefined || viewDecisions === null ? null : { roleName: viewAsRole.name, decisions: viewDecisions }}
            selectedPlacementAlias={selected?.kind === "placement" ? selected.placementAlias : null}
            onSelectPlacement={(alias) => Promise.resolve(alias !== null
              ? draft.select({ kind: "placement", placementAlias: alias })
              : canvasPageRef.current !== undefined && draft.select({ kind: "page", pageAlias: canvasPageRef.current }))}
            breakpoint={breakpoint} disabled={draft.locked} compileFailure={view.failure}
            onChange={applyPuckPageEdit} readRecords={readCanvasRecords} updating={draft.updatingCanvas}
            palette={addTargets === null ? undefined : { host: paletteHost, targets: addTargets, message: paletteMessage, onAdd: addBlock }} />
        </Suspense>
      </div>}
  </section>;

  const toolbar = (inspectorOpen: boolean, toggleInspector: () => void, centreTitle: string, showsCanvas: boolean) =>
    <StudioCanvasToolbar title={centreTitle} breakpoint={breakpoint} onBreakpoint={setBreakpoint}
      zoom={canvasZoom} onZoom={setCanvasZoom} showsCanvas={showsCanvas && canvasPage !== undefined}
      appearance={appearance} onAppearance={setAppearance}
      viewAs={{ value: viewAsRole === undefined ? null : viewAs, onChange: setViewAs,
        roles: source.body.roles.filter((role) => view.frames?.roles[role.key] !== undefined) }}
      inspectorOpen={inspectorOpen} onToggleInspector={toggleInspector} />;

  const dialog = <StudioBlockSetupDialog request={blockSetup} choices={draftChoices} onClose={() => setBlockSetup(null)} />;

  return {
    panels, inspector: inspectorPanel, centre, toolbar, dialog, title, breadcrumbItem, compositionContext,
    commandComposition, readRecordChoices, previewAs,
    readQueries: () => studioDraftChoices(draft.parsed(draft.history.getState().source), view.borrowedChoices, null).queries,
  };
}
