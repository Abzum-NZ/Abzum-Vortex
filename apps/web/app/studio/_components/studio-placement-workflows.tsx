"use client";
import { useState } from "react";
import { Button } from "@vortex/ui/components/button";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import {
  StudioIconButton,
  StudioRowActionsBindings,
  type StudioActionChoice,
  type StudioRowAction,
  StudioInspectorGroup,
  studioFlowLabel,
  type StudioFlowCreateChoices,
  type StudioFlowCreateCommand,
  type StudioFlowSelection,
} from "@vortex/ui/studio";
import { StudioNewFlowDialog } from "./studio-new-flow-dialog";

const eventNames: Readonly<Record<string, string>> = {
  action: "When used",
  row_clicked: "When a row is clicked",
  row_action: "Row action",
  card_moved: "When a card is moved",
  card_added: "When a card is added to a column",
  form_submit: "When submitted",
  row_edit: "When a row is saved",
  inline_edit: "When a value is edited",
};

/**
 * The placed control's workflows in its inspector: each flow bound to one of its events opens on the
 * Flows tab; a control that raises an action and has no flow for it can get a new one.
 */
export function StudioPlacementWorkflows({
  source,
  placementAlias,
  createChoices,
  disabled,
  onOpen,
  onCreate,
  namedActions,
  onAddRowAction,
  onChangeRowActions,
}: Readonly<{
  source: ApplicationSourceDocument;
  placementAlias: string;
  createChoices: StudioFlowCreateChoices;
  disabled: boolean;
  onOpen: (selection: StudioFlowSelection) => void;
  onCreate: (command: StudioFlowCreateCommand) => string | true;
  namedActions: readonly StudioActionChoice[];
  onAddRowAction: (command: StudioFlowCreateCommand) => true | string;
  onChangeRowActions: (
    expected: readonly StudioRowAction[],
    next: readonly StudioRowAction[],
  ) => true | string;
}>) {
  const [creating, setCreating] = useState(false);
  const bindings = source.body.flow_bindings.filter(
    (binding) => binding.control === placementAlias,
  );
  const canCreate = createChoices.actions.some((entry) => entry.controlAlias === placementAlias);
  if (bindings.length === 0 && !canCreate) return null;
  return (
    <StudioInspectorGroup title="Workflow">
      <StudioRowActionsBindings
        source={source}
        placementAlias={placementAlias}
        createChoices={createChoices}
        namedActions={namedActions}
        disabled={disabled}
        onCreate={onAddRowAction}
        onChange={onChangeRowActions}
      />
      {bindings.map((binding) => {
        const flow = source.body.flows.find(
          (entry) => entry.id === binding.flow || entry.key === binding.flow,
        );
        return (
          <div
            key={binding.id}
            className="flex min-h-9 items-center justify-between gap-2 rounded-md px-1 text-sm hover:bg-muted"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {flow === undefined ? "A flow that is missing" : studioFlowLabel(flow)}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {eventNames[binding.event] ?? "When used"}
              </span>
            </span>
            <StudioIconButton
              label="Edit workflow"
              disabled={disabled || flow === undefined}
              onClick={() => {
                if (flow !== undefined)
                  onOpen({ kind: "flow", flowAlias: flow.id, moduleKey: null });
              }}
            >
              <Icon name="workflow" />
            </StudioIconButton>
          </div>
        );
      })}
      {canCreate && (
        <>
          <p className="text-sm text-muted-foreground">
            Choose an unbound event to create a flow or bind an existing one.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" />
            Create workflow
          </Button>
          <StudioNewFlowDialog
            key={placementAlias}
            open={creating}
            onOpenChange={setCreating}
            choices={createChoices}
            source={source}
            onCreate={onCreate}
            initialControl={placementAlias}
          />
        </>
      )}
    </StudioInspectorGroup>
  );
}
