"use client";
import { useState } from "react";
import { Button } from "@vortex/ui/components/button";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import {
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
  form_submit: "When submitted",
  bulk_action: "Bulk action",
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
}: Readonly<{
  source: ApplicationSourceDocument;
  placementAlias: string;
  createChoices: StudioFlowCreateChoices;
  disabled: boolean;
  onOpen: (selection: StudioFlowSelection) => void;
  onCreate: (command: StudioFlowCreateCommand) => string | true;
}>) {
  const [creating, setCreating] = useState(false);
  const bindings = source.body.flow_bindings.filter(
    (binding) => binding.control === placementAlias,
  );
  const canCreate = createChoices.actions.some((entry) => entry.controlAlias === placementAlias);
  if (bindings.length === 0 && !canCreate) return null;
  return (
    <StudioInspectorGroup title="Workflow">
      {bindings.map((binding) => {
        const flow = source.body.flows.find(
          (entry) => entry.id === binding.flow || entry.key === binding.flow,
        );
        return (
          <div key={binding.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">
              {eventNames[binding.event] ?? "When used"}:{" "}
              {flow === undefined ? "a flow that is missing" : studioFlowLabel(flow)}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || flow === undefined}
              onClick={() => {
                if (flow !== undefined)
                  onOpen({ kind: "flow", flowAlias: flow.id, moduleKey: null });
              }}
            >
              Edit workflow
            </Button>
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
            variant="outline"
            disabled={disabled}
            onClick={() => setCreating(true)}
          >
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
