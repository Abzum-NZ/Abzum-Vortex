import "server-only";

import { randomUUID } from "node:crypto";
import { flowSchema, flowTaskChildLists, sameId, type ComponentFlowBinding } from "../../schema";
import type { RequestDatabaseTransaction } from "../../db";
import type { FlowNamedAction } from "../../definition/flow-orchestrator-types";
import type { InstalledRuntimeContext } from "../../definition/installed-runtime-context";
import { installedNamedActions } from "../../definition/installed-named-actions";
import { collectActionFlowTasks, flowLibraryOf } from "../../rules";
import type { RecordsTableFeatureProjection } from ".";
import { projectNamedActionAvailability } from "./named-action-availability";

type RowActions = NonNullable<RecordsTableFeatureProjection["rowActions"]>;
export type RowActionInstallation = Readonly<{
  bindings: readonly ComponentFlowBinding[];
  flows: ReadonlyMap<string, unknown>;
  namedActions: ReadonlyMap<string, FlowNamedAction>;
}>;

/** The flow bindings, flows and named actions of the installed release a row's commands run in. */
export const rowActionInstallationOf = ({
  releaseSet: { application, modules },
}: Pick<InstalledRuntimeContext, "releaseSet">): RowActionInstallation => ({
  bindings: application.content.flowBindings,
  flows: new Map(
    [...application.content.flows, ...modules.flatMap((module) => module.content.flows)].map(
      (flow) => [String(flow.id), flow],
    ),
  ),
  namedActions: installedNamedActions(application, modules),
});

/**
 * A named-action button binds the same interactive flow as every other row button. Its one Call
 * protected operation step (including inside a confirmation branch) names the installed action explicitly and supplies no per-record inputs.
 * Other workflows keep their own forms, conditions and confirmations and run as workflows.
 */
const namedActionFor = (
  installed: RowActionInstallation,
  placementId: string,
  eventId: string,
): FlowNamedAction | undefined => {
  const binding = installed.bindings.find(
    (entry) =>
      entry.event === "row_action" &&
      sameId(entry.controlId, placementId) &&
      sameId(entry.eventId, eventId),
  );
  if (binding === undefined) throw new Error("ROW_ACTION_BINDING_MISSING");
  const flow = flowSchema.parse(installed.flows.get(binding.flow.flowId));
  const pending = [...flow.tasks];
  const calls = [];
  while (pending.length > 0) {
    const task = pending.pop()!;
    for (const child of flowTaskChildLists(task)) pending.push(...child.tasks);
    if (task.type === "operation.call") calls.push(task);
  }
  if (calls.length !== 1) return undefined;
  const task = calls[0]!;
  const operation = task.properties.operation;
  if (
    operation?.kind !== "literal" ||
    operation.literal.type !== "text" ||
    typeof operation.literal.value !== "string"
  )
    return undefined;
  const inputs = task.properties.inputs;
  if (inputs?.kind !== "map" || Object.keys(inputs.entries).length !== 0) return undefined;
  return installed.namedActions.get(operation.literal.value);
};

/**
 * The shared #3182 evaluator decides every named-action-backed command for every visible row in
 * one batch. Flow commands retain the capability decisions from the protected page read. Nothing
 * reads another page, changes a record or exposes business values from an eligibility preview.
 */
export const projectRowActionAvailability = async (
  transaction: RequestDatabaseTransaction,
  installed: RowActionInstallation,
  placementId: string,
  recordTypeId: string,
  projection: RowActions,
  issuedAt: string,
): Promise<RowActions> => {
  const library = flowLibraryOf(installed.flows);
  const named = projection.actions.flatMap((declaration) => {
    const action = namedActionFor(installed, placementId, declaration.eventId);
    if (action === undefined) return [];
    if (!sameId(action.subjectRecordTypeId, recordTypeId))
      throw new Error("ROW_ACTION_RECORD_TYPE_MISMATCH");
    const flowId = action.action.actionId;
    const actionFlow = library(flowId);
    if (
      actionFlow === undefined ||
      actionFlow.execution !== "transaction" ||
      actionFlow.runAs.kind !== "saver" ||
      actionFlow.triggers.length !== 0
    )
      throw new Error("ROW_ACTION_NAMED_FLOW_INVALID");
    const runId = randomUUID();
    return [
      {
        key: declaration.eventId,
        action: action.action,
        run: (seed: Parameters<typeof collectActionFlowTasks>[3]) =>
          collectActionFlowTasks(library, flowId, runId, seed),
      },
    ];
  });
  if (named.length === 0 || projection.availability.length === 0) return projection;
  const availability = await projectNamedActionAvailability(
    transaction,
    recordTypeId,
    projection.availability.map(({ recordId, revision }) => ({ recordId, revision })),
    named,
    issuedAt,
  );
  const namedKeys = new Set(named.map((action) => action.key));
  const byRecord = new Map(availability.map((row) => [row.recordId.toLowerCase(), row]));
  return {
    actions: projection.actions,
    availability: projection.availability.map((row) => ({
      ...row,
      actions: row.actions.map((decision) => {
        if (!namedKeys.has(decision.action)) return decision;
        const current = byRecord
          .get(row.recordId.toLowerCase())
          ?.actions.find((action) => sameId(action.action, decision.action));
        if (current === undefined) throw new Error("ROW_ACTION_NAMED_AVAILABILITY_MISSING");
        return decision.eligible ? current : decision;
      }),
    })),
  };
};
