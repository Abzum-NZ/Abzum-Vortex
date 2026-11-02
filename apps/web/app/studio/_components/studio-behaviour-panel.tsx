"use client";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { useState } from "react";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import type {
  ApplicationSourceDocument,
  FlowBindingSettings,
  ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import {
  flowBindingConcurrencySchema,
  flowBindingExclusiveScopeSchema,
  flowBindingMaximumTimeoutMs,
  defaultFlowBindingSettings,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import {
  StudioIconButton,
  StudioOptionControl,
  StudioRowActionsBindings,
  type StudioActionChoice,
  type StudioBehaviourEvent,
  type StudioBehaviourResult,
  type StudioBehaviourTarget,
  type StudioFlowCombineResult,
  type StudioRowAction,
  StudioInspectorGroup,
  applyStudioBindingSettings,
  applyStudioFlowCombine,
  applyStudioRebind,
  applyStudioResetToDefault,
  applyStudioUnbind,
  studioBindingDefault,
  type StudioBorrowedChoices,
  projectStudioBehaviour,
  type StudioFlowCreateChoices,
  type StudioFlowCreateCommand,
  type StudioFlowSelection,
} from "@vortex/ui/studio";
import { StudioNewFlowDialog } from "./studio-new-flow-dialog";
import { StudioFormulaEditor, type FormulaReferenceChoice } from "./studio-formula-editor";

const concurrencyWords: Readonly<Record<string, string>> = {
  ignore_while_running: "Ignore it while the flow runs",
  latest_wins: "The latest one wins",
  queue: "Run them one after another",
};
const exclusiveWords: Readonly<Record<string, string>> = {
  none: "Nothing else is held",
  form: "Hold the form",
  page: "Hold the page",
};

/** One edit of the draft: a pure change of the source, run as one undoable step. */
export type StudioBehaviourEdit = (
  apply: (source: ApplicationSourceDocument) => StudioBehaviourResult | StudioFlowCombineResult,
) => string | true;

/**
 * The Behaviour of a placed component or of the page: every event it raises (the events its block
 * declares in the catalogue, or the page's own), each with the flow it runs. From here a builder
 * opens that flow, makes the event run another flow, creates a new one, combines two flows into
 * one, and sets how the event starts the flow (start condition, debounce, concurrency, exclusive
 * scope, timeout).
 */
export function StudioBehaviourPanel({
  source,
  catalogue,
  target,
  createChoices,
  disabled,
  references,
  borrowed,
  onOpen,
  onCreate,
  onEdit,
  namedActions,
  onAddRowAction,
  onChangeRowActions,
}: Readonly<{
  source: ApplicationSourceDocument;
  catalogue: ImmutablePlatformBlockCatalogue;
  target: StudioBehaviourTarget;
  createChoices: StudioFlowCreateChoices;
  disabled: boolean;
  /** The page values a start condition can read. */
  references: readonly FormulaReferenceChoice[];
  /** What the modules this application uses offer, for a default flow made again. */
  borrowed: StudioBorrowedChoices | null;
  onOpen: (selection: StudioFlowSelection) => void;
  onCreate: (command: StudioFlowCreateCommand) => string | true;
  onEdit: StudioBehaviourEdit;
  namedActions: readonly StudioActionChoice[];
  onAddRowAction: (command: StudioFlowCreateCommand) => true | string;
  onChangeRowActions: (
    expected: readonly StudioRowAction[],
    next: readonly StudioRowAction[],
  ) => true | string;
}>) {
  const [creating, setCreating] = useState<string | null>(null);
  const control = target.kind === "page" ? target.pageAlias : target.placementAlias;
  const events = projectStudioBehaviour({ source, catalogue }, target);
  const canCreate = createChoices.actions.some((entry) => entry.controlAlias === control);
  if (events.length === 0 && !canCreate && target.kind === "page") return null;
  const interactive = source.body.flows.filter((flow) => flow.execution === "interactive");
  const bound = events.filter((entry) => entry.binding !== null).length;
  return (
    <StudioInspectorGroup
      title="Behaviour"
      defaultOpen={bound > 0}
      summary={bound === 0 ? "No flows" : bound === 1 ? "1 flow" : `${bound} flows`}
    >
      {target.kind === "placement" && (
        <StudioRowActionsBindings
          source={source}
          placementAlias={control}
          createChoices={createChoices}
          namedActions={namedActions}
          disabled={disabled}
          onCreate={onAddRowAction}
          onChange={onChangeRowActions}
        />
      )}
      {events.map((entry) => (
        <BehaviourEvent
          key={entry.event}
          entry={entry}
          source={source}
          interactive={interactive}
          disabled={disabled}
          references={references}
          borrowed={borrowed}
          canCreate={createChoices.actions.some(
            (choice) => choice.controlAlias === control && choice.event === entry.event,
          )}
          onOpen={onOpen}
          onEdit={onEdit}
          onCreate={() => setCreating(entry.event)}
        />
      ))}
      {creating !== null && (
        <StudioNewFlowDialog
          key={`${control}:${creating}`}
          open
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
          choices={createChoices}
          source={source}
          onCreate={onCreate}
          initialControl={control}
          initialEvent={creating}
        />
      )}
    </StudioInspectorGroup>
  );
}

function BehaviourEvent({
  entry,
  source,
  interactive,
  disabled,
  references,
  borrowed,
  canCreate,
  onOpen,
  onEdit,
  onCreate,
}: Readonly<{
  entry: StudioBehaviourEvent;
  source: ApplicationSourceDocument;
  interactive: ApplicationSourceDocument["body"]["flows"];
  disabled: boolean;
  references: readonly FormulaReferenceChoice[];
  borrowed: StudioBorrowedChoices | null;
  canCreate: boolean;
  onOpen: (selection: StudioFlowSelection) => void;
  onEdit: StudioBehaviourEdit;
  onCreate: () => void;
}>) {
  const [problem, setProblem] = useState("");
  const binding = entry.binding;
  const flow =
    binding === null
      ? undefined
      : source.body.flows.find((candidate) => candidate.key === binding.flowKey);
  const others = interactive.filter((candidate) => candidate.key !== binding?.flowKey);
  const run = (apply: Parameters<StudioBehaviourEdit>[0]) => {
    const result = onEdit(apply);
    setProblem(result === true ? "" : result);
  };
  return (
    <div className="space-y-1.5 rounded-md border p-2" aria-label={entry.label}>
      <div className="flex min-h-9 items-center justify-between gap-2 text-sm">
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {binding === null ? "No flow yet" : binding.flowName}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{entry.label}</span>
        </span>
        {flow !== undefined && (
          <StudioIconButton
            label="Edit workflow"
            disabled={disabled}
            onClick={() => onOpen({ kind: "flow", flowAlias: flow.id, moduleKey: null })}
          >
            <Icon name="workflow" />
          </StudioIconButton>
        )}
      </div>
      {binding === null ? (
        canCreate && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCreate}>
            <Icon name="plus" />
            Create workflow
          </Button>
        )
      ) : (
        <>
          {others.length > 0 && (
            <>
              <Label className="flex flex-col items-start gap-1 text-xs">
                Run another flow
                <StudioOptionControl
                  value=""
                  unset="Choose a flow…"
                  disabled={disabled}
                  options={others.map((candidate) => ({
                    value: candidate.key,
                    label: candidate.labels.name ?? candidate.key,
                  }))}
                  onChange={(value) => {
                    if (value !== "")
                      run((current) => applyStudioRebind(current, binding.id, value));
                  }}
                />
              </Label>
              <Label className="flex flex-col items-start gap-1 text-xs">
                Combine with another flow
                <StudioOptionControl
                  value=""
                  unset="Choose a flow…"
                  disabled={disabled}
                  options={others.map((candidate) => ({
                    value: candidate.key,
                    label: candidate.labels.name ?? candidate.key,
                  }))}
                  onChange={(value) => {
                    if (value !== "")
                      run((current) => applyStudioFlowCombine(current, binding.id, value));
                  }}
                />
              </Label>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => run((current) => applyStudioUnbind(current, binding.id))}
          >
            Stop running this flow
          </Button>
          {studioBindingDefault(source, binding.id) !== undefined && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                run((current) => applyStudioResetToDefault(current, binding.id, borrowed))
              }
            >
              Go back to the default flow
            </Button>
          )}
          <BindingSettings
            settings={binding.settings}
            event={entry.event}
            disabled={disabled}
            references={references}
            onChange={(settings) =>
              run((current) => applyStudioBindingSettings(current, binding.id, settings))
            }
          />
        </>
      )}
      {problem !== "" && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function BindingSettings({
  settings,
  event,
  disabled,
  references,
  onChange,
}: Readonly<{
  settings: FlowBindingSettings;
  event: StudioBehaviourEvent["event"];
  disabled: boolean;
  references: readonly FormulaReferenceChoice[];
  onChange: (settings: FlowBindingSettings) => void;
}>) {
  const defaults = defaultFlowBindingSettings(event);
  const changed = JSON.stringify(settings) !== JSON.stringify(defaults);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Run settings{changed ? " (changed)" : ""}
      </summary>
      <div className="mt-2 space-y-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`condition-${event}`}>
            Start only when
          </Label>
          {settings.condition === null ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || references.length === 0}
              onClick={() =>
                onChange({
                  ...settings,
                  condition: { op: "literal", type: "yes_no", value: true },
                })
              }
            >
              {references.length === 0 ? "Declare a page value first" : "Add a start condition"}
            </Button>
          ) : (
            <>
              <StudioFormulaEditor
                id={`condition-${event}`}
                value={settings.condition}
                references={references}
                disabled={disabled}
                onChange={(formula, error) => {
                  if (formula !== undefined && error === undefined)
                    onChange({ ...settings, condition: formula });
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange({ ...settings, condition: null })}
              >
                Remove the start condition
              </Button>
            </>
          )}
        </div>
        <Label className="flex flex-col items-start gap-1 text-xs">
          Wait before starting (milliseconds, at most 250)
          <Input
            type="number"
            min={0}
            max={250}
            step={50}
            disabled={disabled}
            value={settings.debounceMs}
            onChange={(next) => {
              const value = Number(next.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= 250)
                onChange({ ...settings, debounceMs: value });
            }}
          />
        </Label>
        <Label className="flex flex-col items-start gap-1 text-xs">
          When it happens again while the flow runs
          <StudioOptionControl
            value={settings.concurrency}
            disabled={disabled}
            options={flowBindingConcurrencySchema.options.map((option) => ({
              value: option,
              label: concurrencyWords[option] ?? option,
            }))}
            onChange={(value) => {
              const parsed = flowBindingConcurrencySchema.safeParse(value);
              if (parsed.success) onChange({ ...settings, concurrency: parsed.data });
            }}
          />
        </Label>
        <Label className="flex flex-col items-start gap-1 text-xs">
          While it runs
          <StudioOptionControl
            value={settings.exclusive}
            disabled={disabled}
            options={flowBindingExclusiveScopeSchema.options.map((option) => ({
              value: option,
              label: exclusiveWords[option] ?? option,
            }))}
            onChange={(value) => {
              const parsed = flowBindingExclusiveScopeSchema.safeParse(value);
              if (!parsed.success) return;
              onChange({
                ...settings,
                exclusive: parsed.data,
                timeoutMs:
                  parsed.data === "none"
                    ? settings.timeoutMs
                    : (settings.timeoutMs ?? flowBindingMaximumTimeoutMs),
              });
            }}
          />
        </Label>
        <Label className="flex flex-col items-start gap-1 text-xs">
          Give up after (seconds{settings.exclusive === "none" ? ", optional" : ", required"})
          <Input
            type="number"
            min={1}
            max={flowBindingMaximumTimeoutMs / 1000}
            disabled={disabled}
            value={settings.timeoutMs === null ? "" : settings.timeoutMs / 1000}
            onChange={(next) => {
              const text = next.target.value;
              if (text === "") {
                if (settings.exclusive === "none") onChange({ ...settings, timeoutMs: null });
                return;
              }
              const seconds = Number(text);
              if (Number.isFinite(seconds) && seconds >= 0.1)
                onChange({ ...settings, timeoutMs: Math.round(seconds * 1000) });
            }}
          />
        </Label>
        {changed && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange({ ...defaults })}
          >
            Use the usual settings
          </Button>
        )}
      </div>
    </details>
  );
}
