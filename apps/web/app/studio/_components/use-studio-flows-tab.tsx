"use client";
import { useIntentPreload } from "../_lib/use-intent-preload";
import dynamic from "next/dynamic";
import { useCallback, useMemo, type ReactNode } from "react";
import {
  describeFailure,
  checkFlowFormula,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import { useAppearanceMode } from "@vortex/ui/appearance";
import {
  studioActionChoices,
  applyStudioRowActionChange,
  applyStudioFlowCommand,
  applyStudioFlowCreate,
  applyStudioFlowStart,
  describeStudioFlowStarts,
  describeStudioFlowBehaviour,
  projectStudioFlowCreateChoices,
  projectStudioFlowDraftChoices,
  projectStudioFlowStart,
  projectStudioFlowStepActions,
  studioFlowConditionContext,
  studioFlowReferenceChoices,
  studioFlowFieldOptions,
  studioFlowStepTypesAt,
  studioFlowStepTypesUnder,
  studioFixedLiteralType,
  studioFlowValueOf,
  studioFlowValueSourceOf,
  samePath,
  studioFlowOfSelection,
  studioFlowOutline,
  studioSemanticSelectionKey,
  type StudioFlowCommand,
  type StudioFlowContext,
  type StudioFlowCreateCommand,
  type StudioFlowCreateResult,
  type StudioFlowEditResult,
  type StudioFlowPath,
  type StudioFlowSelection,
  type StudioFlowStartDraft,
  type StudioFlowStepPickerContext,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";
import type { StudioDraft, StudioDraftStep } from "./use-studio-draft";
import { deferredStudioPart } from "./studio-deferred-part";
import { useStudioTabVisited } from "./studio-frame";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import { StudioFormulaEditor, formulaReferenceName } from "./studio-formula-editor";
import { FixedInput, startLiteral, StudioFlowValueControl } from "./studio-flow-value-control";

// The workflow canvas pulls in @xyflow/react; load it only when the Flows tab shows a flow.
const StudioFlowCanvas = dynamic(
  () => import("@vortex/ui/studio/flow-canvas").then((module) => module.StudioFlowCanvas),
  { ssr: false },
);
const StudioFlowsPanel = deferredStudioPart(
  () => import("./studio-flows-panel").then((module) => module.StudioFlowsPanel),
  "flows panel",
);
const StudioFlowInspector = deferredStudioPart(
  () => import("./studio-flow-inspector").then((module) => module.StudioFlowInspector),
  "flow inspector",
);
const StudioPlacementWorkflows = deferredStudioPart(
  () => import("./studio-placement-workflows").then((module) => module.StudioPlacementWorkflows),
  "workflows of this control",
);
const preloadFlowsTab = () =>
  Promise.all([
    import("@vortex/ui/studio/flow-canvas"),
    import("./studio-flows-panel"),
    import("./studio-flow-inspector"),
  ]);

/**
 * The Flows tab of the one Studio: its panel (the flows), its centre (the workflow canvas), its
 * inspector (the selected step) and the placement inspector's Workflow section. Every change is one
 * flow command or one flow creation run through the draft's one command envelope, and saved by its
 * autosave like every other Studio edit.
 */
export function useStudioFlowsTab({
  draft,
  catalogue,
  labels,
  applications,
  hidden,
  openFlowsTab,
}: Readonly<{
  draft: StudioDraft;
  catalogue: ImmutablePlatformBlockCatalogue;
  /** Selection key to the label Studio shows for it. */
  labels: ReadonlyMap<string, string>;
  applications: readonly StudioModuleOwnerApplication[];
  hidden: boolean;
  openFlowsTab: () => void;
}>) {
  useIntentPreload(preloadFlowsTab, "#studio-rail-flows");
  const panelVisited = useStudioTabVisited(!hidden);
  const { state, source, selected } = draft;
  const appearance = useAppearanceMode();
  const disabled = draft.locked;
  // The flow and its selected step are the workspace's one selection (a flow or a flow step).
  const currentFlow = studioFlowOfSelection(selected);
  const selectionKey = currentFlow === null ? "" : studioSemanticSelectionKey(currentFlow);
  // A step selection names its flow anew each time; the flow stays the same object while its key does.
  const flowSelection = useMemo(() => currentFlow, [selectionKey]);
  const stepId = selected?.kind === "flow_step" ? selected.taskId : null;

  const context = useMemo(
    (): StudioFlowContext => ({
      organizationId: draft.organizationId,
      rootId: state.rootId,
      key: draft.saved.key,
      draftRevision: state.draftRevision,
      localLifetime: draft.lifetime,
      catalogue,
      source: state.source as ApplicationSourceDocument,
    }),
    [
      draft.organizationId,
      state.rootId,
      draft.saved.key,
      state.draftRevision,
      state.source,
      draft.lifetime,
      catalogue,
    ],
  );
  const controlLabel = useCallback(
    (alias: string) =>
      labels.get(studioSemanticSelectionKey({ kind: "placement", placementAlias: alias })) ??
      "a control",
    [labels],
  );
  const outline = useMemo(() => {
    if (flowSelection === null) return null;
    try {
      return studioFlowOutline(context, flowSelection);
    } catch (cause) {
      console.error(
        "[studio] the selected flow could not be drawn",
        { flow: flowSelection.flowAlias },
        describeFailure(cause),
      );
      return null;
    }
  }, [context, flowSelection]);
  const stepPath =
    stepId === null || outline === null
      ? null
      : (outline.entries.find((entry) => entry.task.id === stepId)?.path ?? null);
  // Choosing a step on the canvas or after an edit is a selection change like any other.
  const selectStep = useCallback(
    (path: StudioFlowPath | null) => {
      if (flowSelection === null) return;
      const entry =
        path === null || outline === null
          ? undefined
          : outline.entries.find((candidate) => samePath(candidate.path, path));
      const next: StudioSemanticSelection =
        entry === undefined
          ? flowSelection
          : {
              kind: "flow_step",
              flowAlias: flowSelection.flowAlias,
              moduleKey: flowSelection.moduleKey,
              taskId: entry.task.id,
            };
      draft.select(next);
    },
    [flowSelection, outline, draft],
  );
  const starts = useMemo(
    () =>
      flowSelection === null ? [] : describeStudioFlowStarts(source, flowSelection, controlLabel),
    [source, flowSelection, controlLabel],
  );
  const behaviour = useMemo(
    () =>
      flowSelection === null
        ? []
        : describeStudioFlowBehaviour(source, flowSelection, controlLabel),
    [source, flowSelection, controlLabel],
  );
  const draftChoices = useMemo(
    () => projectStudioFlowDraftChoices({ rootId: state.rootId, source, catalogue }),
    [state.rootId, source, catalogue],
  );
  const flowChoices = useMemo(
    () =>
      outline === null
        ? draftChoices
        : projectStudioFlowDraftChoices({
            rootId: state.rootId,
            source,
            catalogue,
            flow: outline.flow,
          }),
    [outline, draftChoices, state.rootId, source, catalogue],
  );
  const start = useMemo(
    () =>
      flowSelection === null
        ? null
        : projectStudioFlowStart(
            source,
            flowSelection,
            (control) => draftChoices.forms.find((form) => form.alias === control)?.fields ?? [],
          ),
    [source, flowSelection, draftChoices],
  );
  const borrowed = draft.view.borrowedChoices;
  const createChoices = useMemo(
    () =>
      projectStudioFlowCreateChoices(
        { rootId: state.rootId, source, catalogue, borrowed },
        controlLabel,
      ),
    [state.rootId, source, catalogue, borrowed, controlLabel],
  );

  // The live snapshot inside a command: the history's current entry, never the rendered one.
  const live = (): StudioFlowContext => {
    const current = draft.history.getState();
    return {
      organizationId: draft.organizationId,
      rootId: current.rootId,
      key: draft.saved.key,
      draftRevision: current.draftRevision,
      localLifetime: draft.lifetime,
      catalogue,
      source: current.source as ApplicationSourceDocument,
    };
  };

  /**
   * The one flow edit path: a checked flow edit run through the draft's envelope. An applied result
   * carries the source the draft holds afterwards, so an editor knows which snapshot its input stands on.
   */
  const edit = (
    what: string,
    apply: (current: StudioFlowContext) => StudioFlowEditResult,
    merge: string | undefined,
  ): StudioFlowEditResult => {
    const outcome = draft.run(
      (): StudioDraftStep<StudioFlowEditResult> => {
        const current = live();
        const result = apply(current);
        if (result.kind !== "applied") {
          console.error(
            `[studio] ${what} refused (${result.kind}): ${result.reason}`,
            result.cause === undefined ? "" : describeFailure(result.cause),
          );
          return { kind: "keep", result };
        }
        return { kind: "edit", source: result.source, result };
      },
      merge === undefined ? {} : { merge },
    );
    if (outcome.kind === "blocked") return { kind: "stale", reason: outcome.message };
    return outcome.result.kind === "applied"
      ? { ...outcome.result, source: draft.history.getState().source as ApplicationSourceDocument }
      : outcome.result;
  };

  const command = (
    expected: StudioFlowContext,
    expectedSelection: StudioFlowSelection,
    flowCommand: StudioFlowCommand,
    merge?: string,
  ): StudioFlowEditResult =>
    edit(
      "flow edit",
      (current) =>
        applyStudioFlowCommand(
          current,
          expected,
          draft.selection.getSelection(),
          expectedSelection,
          flowCommand,
        ),
      merge,
    );

  // How the flow starts is written through the same checked path as a step change.
  const startCommand = (
    expected: StudioFlowContext,
    startDraft: StudioFlowStartDraft,
    merge?: string,
  ): StudioFlowEditResult =>
    flowSelection === null
      ? { kind: "stale", reason: "Choose a flow first." }
      : edit(
          "flow start edit",
          (current) =>
            applyStudioFlowStart(
              current,
              expected,
              draft.selection.getSelection(),
              flowSelection,
              startDraft,
            ),
          merge,
        );

  const create = (
    createCommand: StudioFlowCreateCommand,
    stayOnPlacement = false,
  ): string | true => {
    const outcome = draft.run((current): StudioDraftStep<StudioFlowCreateResult> => {
      const result = applyStudioFlowCreate(current, createCommand, borrowed);
      return result.kind === "applied"
        ? { kind: "edit", source: result.source, result }
        : { kind: "keep", result };
    });
    if (outcome.kind === "blocked") return outcome.message;
    const result = outcome.result;
    if (result.kind !== "applied") return result.reason;
    if (!stayOnPlacement) {
      openFlowsTab();
      draft.select(result.selection);
    }
    return true;
  };

  const openFlow = (flow: StudioFlowSelection) => {
    openFlowsTab();
    draft.select(flow);
  };

  const owner =
    flowSelection?.moduleKey === null || flowSelection === null
      ? undefined
      : source.body.modules.find((module) => module.key === flowSelection.moduleKey);
  const stepTypes = useMemo(
    () =>
      flowSelection === null
        ? []
        : projectStudioFlowStepActions(context, flowSelection, null).stepTypes,
    [context, flowSelection],
  );
  const pickerContext = (path: StudioFlowPath): StudioFlowStepPickerContext => {
    if (outline === null || flowSelection === null) throw new Error("FLOW_PICKER_WITHOUT_FLOW");
    const references = studioFlowReferenceChoices(
      source,
      outline.flow,
      outline.siblings,
      flowSelection.moduleKey,
      path,
      flowChoices.forms,
    );
    return {
      condition: studioFlowConditionContext(references),
      fields: studioFlowFieldOptions(source, outline.flow, flowSelection.moduleKey, {}) ?? [],
      flows: outline.siblings.filter((flow) => flow.id !== outline.flow.id),
      firstStepTypes: (control, types) => studioFlowStepTypesUnder(types, outline.flow, [control]),
      renderExpression: ({ id, value, onChange }) => (
        <StudioFormulaEditor
          id={id}
          value={value}
          disabled={disabled}
          references={references.map((entry) => ({
            ...entry,
            name: formulaReferenceName(entry.reference),
          }))}
          onChange={(formula, error) => {
            if (formula === undefined || error !== undefined) {
              onChange(undefined, undefined);
              return;
            }
            const type = checkFlowFormula(formula, {
              nowAllowed: true,
              reference: (reference) =>
                references.find(
                  (entry) => JSON.stringify(entry.reference) === JSON.stringify(reference),
                )?.type,
              issue: () => {},
            });
            onChange(formula, type);
          }}
        />
      ),
      renderValue: ({ id, label, type, value, onChange }) => (
        <StudioFlowValueControl
          id={id}
          label={label}
          valueType={type}
          references={references}
          disabled={disabled}
          value={value === null ? null : studioFlowValueSourceOf(value)}
          onChange={(next) => onChange(next === null ? null : studioFlowValueOf(next))}
        />
      ),
      renderLiteral: ({ id, label, type, value, onChange }) => {
        const literalType = type === undefined ? undefined : studioFixedLiteralType(type);
        if (literalType === undefined)
          return (
            <p className="text-sm text-muted-foreground">
              {type === undefined
                ? "Enter a valid value expression first."
                : "This expression type has no fixed case value."}
            </p>
          );
        return (
          <FixedInput
            key={literalType}
            id={id}
            label={label}
            literal={value ?? startLiteral(literalType, [])}
            options={[]}
            long={false}
            disabled={disabled}
            onChange={onChange}
          />
        );
      },
    };
  };
  const typesAt = (path: StudioFlowPath) => {
    if (outline === null || flowSelection === null) return [];
    return studioFlowStepTypesAt(
      stepTypes,
      outline.flow,
      outline.entries,
      path,
      draft.updatingCanvas || draft.view.failure !== null
        ? null
        : (draft.view.flowPlacements?.[flowSelection.moduleKey ?? ""]?.[outline.flow.key]?.tasks ??
            null),
    );
  };

  const panel: ReactNode = !panelVisited ? null : (
    <StudioFlowsPanel
      source={source}
      organizationId={draft.organizationId}
      applications={applications}
      selectedKey={selectionKey}
      hidden={hidden}
      disabled={disabled}
      choose={(next) => {
        draft.select(next);
      }}
      createChoices={createChoices}
      onCreate={create}
    />
  );

  const centre: ReactNode =
    flowSelection === null ? (
      <p className="text-sm text-muted-foreground">
        Choose a flow in the Flows panel to see it on the canvas, or create a new one.
      </p>
    ) : outline === null ? (
      <p role="alert" className="text-sm">
        This flow cannot be drawn because it could not be read from the draft.
      </p>
    ) : (
      <div className="flex h-full min-h-96 flex-col">
        <StudioFlowCanvas
          lists={outline.lists}
          starts={starts}
          behaviour={behaviour}
          placement={
            draft.updatingCanvas || draft.view.failure !== null
              ? null
              : (draft.view.flowPlacements?.[flowSelection.moduleKey ?? ""]?.[outline.flow.key] ??
                null)
          }
          selectedPath={stepPath}
          onSelect={selectStep}
          appearance={appearance}
          typesAt={(insertion) => typesAt(insertion.listPath)}
          disabled={disabled}
          title={labels.get(selectionKey) ?? "Flow"}
          choicesAt={(insertion) => pickerContext([...insertion.listPath, insertion.index])}
          onAdd={(insertion, taskType, settings) => {
            const result = command(context, flowSelection, {
              kind: "insert_task",
              ...insertion,
              taskType,
              settings,
            });
            if (result.kind !== "applied") return result.reason;
            draft.select({
              kind: "flow_step",
              flowAlias: flowSelection.flowAlias,
              moduleKey: flowSelection.moduleKey,
              taskId: result.taskId,
            });
            return true;
          }}
          label={`Workflow canvas of ${labels.get(selectionKey) ?? "the flow"}`}
        />
      </div>
    );

  // Keyed by flow and step only: an applied edit never remounts it, so typing keeps its focus.
  const inspector: ReactNode =
    flowSelection === null || outline === null || start === null ? null : (
      <StudioFlowInspector
        key={`${selectionKey}:${stepId ?? ""}`}
        context={context}
        selection={flowSelection}
        lists={outline.lists}
        stepPath={stepPath}
        choices={flowChoices}
        pickerContext={pickerContext}
        typesAt={typesAt}
        start={start}
        controlLabel={controlLabel}
        disabled={disabled}
        onStart={startCommand}
        ownerNote={
          owner === undefined
            ? undefined
            : `This flow belongs to the module ${owner.name}, which this application owns.`
        }
        onCommand={command}
        onCreate={create}
        onSelectStep={selectStep}
      />
    );

  const placementWorkflows =
    selected?.kind !== "placement" ? null : (
      <StudioPlacementWorkflows
        source={source}
        placementAlias={selected.placementAlias}
        createChoices={createChoices}
        disabled={disabled}
        onOpen={openFlow}
        onCreate={create}
        namedActions={studioActionChoices(source, borrowed)}
        onAddRowAction={(command) => create(command, true)}
        onChangeRowActions={(expected, next) => {
          const outcome = draft.run(
            (current): StudioDraftStep<ReturnType<typeof applyStudioRowActionChange>> => {
              const result = applyStudioRowActionChange(
                current,
                selected.placementAlias,
                expected,
                next,
              );
              return result.kind === "applied"
                ? { kind: "edit", source: result.source, result }
                : { kind: "keep", result };
            },
          );
          return outcome.kind === "blocked"
            ? outcome.message
            : outcome.result.kind === "applied"
              ? true
              : outcome.result.reason;
        }}
      />
    );

  return { panel, centre, inspector, placementWorkflows };
}
