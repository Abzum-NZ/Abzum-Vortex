"use client";
import dynamic from "next/dynamic";
import { useCallback, useMemo, type MutableRefObject, type ReactNode } from "react";
import {
  applicationSourceDocumentSchema, describeFailure,
  type ApplicationRootId, type ApplicationSourceDocument, type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import {
  applyStudioFlowCommand, applyStudioFlowCreate, applyStudioFlowStart, describeStudioFlowStarts, projectStudioFlowCreateChoices,
  projectStudioFlowDraftChoices, projectStudioFlowStart,
  samePath, studioFlowOfSelection, studioFlowOutline, studioSemanticSelectionKey,
  type StudioApplicationDraftHistoryController, type StudioFlowCommand, type StudioFlowContext,
  type StudioFlowCreateCommand, type StudioFlowEditResult, type StudioFlowPath, type StudioFlowSelection, type StudioFlowStartDraft,
  type StudioSemanticSelection, type StudioSemanticSelectionStore,
} from "@vortex/ui/studio";
import type { StudioBusy } from "./use-studio-busy";
import { StudioFlowsPanel } from "./studio-flows-panel";
import { StudioFlowInspector } from "./studio-flow-inspector";
import { StudioPlacementWorkflows } from "./studio-placement-workflows";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";

// The workflow canvas pulls in @xyflow/react; load it only when the Flows tab shows a flow.
const StudioFlowCanvas = dynamic(
  () => import("@vortex/ui/studio/flow-canvas").then((module) => module.StudioFlowCanvas), { ssr: false });

/**
 * The Flows tab of the one Studio: its panel (the flows), its centre (the workflow canvas), its
 * inspector (the selected step) and the placement inspector's Workflow section. Every change is one
 * flow command or one flow creation on the current draft, taken by the draft history exactly as
 * every other Studio edit is.
 */
export function useStudioFlowsTab({ organizationId, draftKey, rootId, history, selectionStore, busy, active, lifetime, workspaceLifetime,
  source, selected, catalogue, labels, applications, disabled, epoch, setMessage, choose, select, openFlowsTab }: Readonly<{
  organizationId: string;
  draftKey: string;
  rootId: ApplicationRootId;
  history: StudioApplicationDraftHistoryController;
  selectionStore: StudioSemanticSelectionStore;
  busy: StudioBusy;
  active: MutableRefObject<boolean>;
  lifetime: MutableRefObject<number>;
  /** The rendered workspace lifetime, which the flow snapshot of this render carries. */
  workspaceLifetime: number;
  source: ApplicationSourceDocument;
  selected: StudioSemanticSelection | null;
  catalogue: ImmutablePlatformBlockCatalogue;
  /** Selection key to the label Studio shows for it. */
  labels: ReadonlyMap<string, string>;
  applications: readonly StudioModuleOwnerApplication[];
  disabled: boolean;
  /** Bumped when unapplied input is discarded (selection change, reopen, import). */
  epoch: number;
  setMessage: (message: string) => void;
  choose: (selection: StudioSemanticSelection) => Promise<boolean> | boolean;
  /** Selects without asking (the selection change itself discards unapplied input). */
  select: (selection: StudioSemanticSelection) => boolean;
  openFlowsTab: () => Promise<boolean>;
}>) {
  const state = history.getState();
  // The flow and its selected step are the workspace's one selection (a flow or a flow step).
  const currentFlow = studioFlowOfSelection(selected);
  const selectionKey = currentFlow === null ? "" : studioSemanticSelectionKey(currentFlow);
  // A step selection names its flow anew each time; the flow stays the same object while its key does.
  const flowSelection = useMemo(() => currentFlow, [selectionKey]);
  const stepId = selected?.kind === "flow_step" ? selected.taskId : null;
  const reportPending = useCallback((pending: boolean) => { busy.report("flowStep", pending); }, [busy]);

  const context = useMemo((): StudioFlowContext => ({
    organizationId, rootId: state.rootId, key: draftKey, draftRevision: state.draftRevision,
    localLifetime: workspaceLifetime, source: state.source as ApplicationSourceDocument,
  }), [organizationId, state.rootId, draftKey, state.draftRevision, state.source, workspaceLifetime]);
  const controlLabel = useCallback((alias: string) =>
    labels.get(studioSemanticSelectionKey({ kind: "placement", placementAlias: alias })) ?? "a control", [labels]);
  const outline = useMemo(() => {
    if (flowSelection === null) return null;
    try { return studioFlowOutline(context, flowSelection); }
    catch (cause) {
      console.error("[studio] the selected flow could not be drawn", { flow: flowSelection.flowAlias }, describeFailure(cause));
      return null;
    }
  }, [context, flowSelection]);
  const stepPath = stepId === null || outline === null ? null
    : outline.entries.find((entry) => entry.task.id === stepId)?.path ?? null;
  // Choosing a step on the canvas or after an edit is a selection change like any other.
  const selectStep = useCallback((path: StudioFlowPath | null) => {
    if (flowSelection === null) return;
    const entry = path === null || outline === null ? undefined
      : outline.entries.find((candidate) => samePath(candidate.path, path));
    const next: StudioSemanticSelection = entry === undefined ? flowSelection
      : { kind: "flow_step", flowAlias: flowSelection.flowAlias, moduleKey: flowSelection.moduleKey, taskId: entry.task.id };
    // A step change asks first only when unapplied input would be lost, like every other selection.
    void choose(next);
  }, [flowSelection, outline, choose]);
  const starts = useMemo(() => flowSelection === null ? [] : describeStudioFlowStarts(source, flowSelection, controlLabel),
    [source, flowSelection, controlLabel]);
  const draftChoices = useMemo(() => projectStudioFlowDraftChoices({ rootId, source, catalogue }), [rootId, source, catalogue]);
  const start = useMemo(() => flowSelection === null ? null : projectStudioFlowStart(source, flowSelection,
    (control) => draftChoices.forms.find((form) => form.alias === control)?.fields ?? []), [source, flowSelection, draftChoices]);
  const createChoices = useMemo(() => projectStudioFlowCreateChoices({ rootId, source, catalogue }, controlLabel),
    [rootId, source, catalogue, controlLabel]);

  // The one flow edit path: a command on the current draft, refused unless nothing else is waiting.
  const command = (expected: StudioFlowContext, expectedSelection: StudioFlowSelection, flowCommand: StudioFlowCommand): StudioFlowEditResult => {
    const blocked = () => !active.current || history.getState().isSaving ||
      busy.any(...(flowCommand.kind === "set_step" ? ["flowStep" as const] : []));
    if (blocked()) return { kind: "stale", reason: "Another change is being applied or is waiting for you. Apply or discard it, then retry." };
    const current = history.getState();
    const currentContext: StudioFlowContext = { organizationId, rootId: current.rootId, key: draftKey,
      draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source as ApplicationSourceDocument };
    const result = applyStudioFlowCommand(currentContext, expected, selectionStore.getSelection(), expectedSelection, flowCommand);
    if (result.kind !== "applied") {
      console.error(`[studio] flow edit refused (${result.kind}): ${result.reason}`, result.cause === undefined ? "" : describeFailure(result.cause));
      return result;
    }
    if (blocked() || history.getState().source !== current.source)
      return { kind: "stale", reason: "The draft changed while this edit was being checked. Retry." };
    if (!history.edit(result.source)) return { kind: "invalid", reason: "The draft did not accept this change, so nothing was changed." };
    setMessage("Flow changed. Save to keep it.");
    return result;
  };

  // How the flow starts is written through the same checked path as a step change.
  const startCommand = (expected: StudioFlowContext, draft: StudioFlowStartDraft): StudioFlowEditResult => {
    if (flowSelection === null || !active.current || history.getState().isSaving || busy.any("flowStep"))
      return { kind: "stale", reason: "Another change is being applied or is waiting for you. Apply or discard it, then retry." };
    const current = history.getState();
    const currentContext: StudioFlowContext = { organizationId, rootId: current.rootId, key: draftKey,
      draftRevision: current.draftRevision, localLifetime: lifetime.current, source: current.source as ApplicationSourceDocument };
    const result = applyStudioFlowStart(currentContext, expected, selectionStore.getSelection(), flowSelection, draft);
    if (result.kind !== "applied") {
      console.error(`[studio] flow start edit refused (${result.kind}): ${result.reason}`, result.cause === undefined ? "" : describeFailure(result.cause));
      return result;
    }
    if (!history.edit(result.source)) return { kind: "invalid", reason: "The draft did not accept this change, so nothing was changed." };
    setMessage("Flow changed. Save to keep it.");
    return result;
  };

  const create = (createCommand: StudioFlowCreateCommand): string | true => {
    if (!active.current || busy.any() || history.getState().isSaving)
      return "Apply or discard the change that is waiting, or let the save finish, then try again.";
    const result = applyStudioFlowCreate(applicationSourceDocumentSchema.parse(history.getState().source), createCommand);
    if (result.kind !== "applied") return result.reason;
    if (!history.edit(result.source)) return "The draft did not accept the new flow, so nothing was changed.";
    void (async () => {
      await openFlowsTab();
      select(result.selection);
    })();
    setMessage("Flow created. Save to keep it.");
    return true;
  };

  const openFlow = (flow: StudioFlowSelection) => {
    void (async () => { if (await openFlowsTab()) await choose(flow); })();
  };

  const owner = flowSelection?.moduleKey === null || flowSelection === null ? undefined
    : source.body.modules.find((module) => module.key === flowSelection.moduleKey);

  const panel = (hidden: boolean): ReactNode => <StudioFlowsPanel source={source} organizationId={organizationId}
    applications={applications} selectedKey={selectionKey} hidden={hidden} disabled={disabled}
    choose={(next) => { void choose(next); }} createChoices={createChoices} onCreate={create} />;

  const centre: ReactNode = flowSelection === null
    ? <p className="text-sm text-muted-foreground">Choose a flow in the Flows panel to see it on the canvas, or create a new one.</p>
    : outline === null
      ? <p role="alert" className="text-sm">This flow cannot be drawn because it could not be read from the draft.</p>
      : <div className="flex h-full min-h-96 flex-col">
        <StudioFlowCanvas lists={outline.lists} starts={starts} selectedPath={stepPath} onSelect={selectStep}
          label={`Workflow canvas of ${labels.get(selectionKey) ?? "the flow"}`} />
      </div>;

  const inspector: ReactNode = flowSelection === null || outline === null || start === null ? null
    : <StudioFlowInspector key={`${selectionKey}:${epoch}:${stepId ?? ""}`} context={context} selection={flowSelection}
      lists={outline.lists} stepPath={stepPath} choices={draftChoices} start={start} controlLabel={controlLabel} disabled={disabled}
      onStart={startCommand}
      ownerNote={owner === undefined ? undefined : `This flow belongs to the module ${owner.name}, which this application owns.`}
      onCommand={command} onSelectStep={selectStep} onPendingChange={reportPending} />;

  const placementWorkflows = selected?.kind !== "placement" ? null
    : <StudioPlacementWorkflows source={source} placementAlias={selected.placementAlias} createChoices={createChoices}
      disabled={disabled} onOpen={openFlow} onCreate={create} />;

  return { panel, centre, inspector, placementWorkflows };
}
