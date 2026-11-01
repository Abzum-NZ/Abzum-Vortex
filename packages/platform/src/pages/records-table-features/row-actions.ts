import "server-only";

import { sameId } from "../../catalogue/runtime-primitives";
import type { ComponentFlowBinding } from "../../definition/application-flow-bindings";
import { flowTaskChildLists, type FlowDefinition } from "../../workflows/flow-contracts";
import { flowPlansOf } from "../../workflows/flow-plan";
import type { RecordsTableFeatureProjection } from "../records-table-feature-projection";
import type { RequestDatabaseTransaction } from "../../db/request-transaction";
import type { FlowNamedAction } from "../../definition/flow-orchestrator-types";
import type { InstalledRuntimeContext } from "../../definition/installed-runtime-context";
import { installedNamedActions } from "../../definition/installed-named-actions";
import type {
  ApplicationActionCapability,
  ApplicationLinkRow,
} from "../../catalogue/application-link";
import type { ApplicationSurfaceAccess } from "../placement-read/types";
import { rowActionIdentity } from "../../definition/application-composition/records-table-features/row-actions";
import { projectNamedActionAvailability } from "./named-action-availability";

type RowActions = NonNullable<RecordsTableFeatureProjection["rowActions"]>;
type RowActionDecision = RowActions["availability"][number]["actions"][number];
type RowActionInstallation = Readonly<{
  bindings: readonly ComponentFlowBinding[];
  flows: ReadonlyMap<string, FlowDefinition>;
  namedActions: ReadonlyMap<string, FlowNamedAction>;
}>;

/** Application facts from the current row and its installed record type's field identities. */
export const applicationLinkRowOf = (
  row: Readonly<{ recordId: string; values: Readonly<Record<string, unknown>> }>,
  fieldIds: ReadonlyMap<string, string>,
): ApplicationLinkRow | undefined => {
  const values = new Map(
    Object.entries(row.values).map(([fieldId, value]) => [fieldId.toLowerCase(), value] as const),
  );
  const valueOf = (key: string): unknown => {
    const fieldId = fieldIds.get(key);
    return fieldId === undefined ? undefined : values.get(fieldId);
  };
  const key = valueOf("key");
  const isSystemApplication = valueOf("is_system_application");
  if (typeof key !== "string" || key.length === 0 || typeof isSystemApplication !== "boolean")
    return undefined;
  const status = valueOf("status");
  return {
    applicationRootId: row.recordId,
    key,
    status: typeof status === "string" ? status : null,
    isSystemApplication,
  };
};

/** The flow bindings, flows and named actions of the installed release a row's commands run in. */
export const rowActionInstallationOf = ({
  releaseSet,
}: Pick<InstalledRuntimeContext, "releaseSet">): RowActionInstallation => ({
  bindings: releaseSet.application.content.flowBindings,
  flows: flowPlansOf(releaseSet).flows,
  namedActions: installedNamedActions(releaseSet.application, releaseSet.modules),
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
  const flow = installed.flows.get(binding.flow.flowId);
  if (flow === undefined) throw new Error("ROW_ACTION_FLOW_MISSING");
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
 * Installing and removing need the installation permission; removing also needs current row facts
 * proving the application is not supplied by the platform. Opening and editing use declared links.
 */
export const applicationCapabilityAllowed = (
  capability: ApplicationActionCapability,
  application: Parameters<ApplicationSurfaceAccess["isOpenable"]>[0] | undefined,
  capabilities: ApplicationSurfaceAccess["capabilities"],
): boolean =>
  capabilities.mayInstall &&
  (capability === "install_application" || application?.isSystemApplication === false);

/**
 * The application row actions of one read: a link action resolves its address per row (and is
 * offered only where one exists), and an application capability is decided from the read's one
 * application-surface decision. Flow actions and named actions are untouched.
 */
export const projectApplicationRowActions = (
  projection: RowActions,
  applicationOf: (recordId: string) => ApplicationLinkRow | undefined,
  surfaces: ApplicationSurfaceAccess,
): RowActions => {
  if (
    projection.actions.every(
      (declaration) =>
        declaration.applicationCapability === undefined && declaration.link === undefined,
    )
  )
    return projection;
  const byIdentity = new Map(
    projection.actions.map((declaration) => [rowActionIdentity(declaration), declaration]),
  );
  return {
    actions: projection.actions,
    availability: projection.availability.map((row) => {
      const application = applicationOf(row.recordId);
      return {
        ...row,
        actions: row.actions.map((decision): RowActionDecision => {
          const declaration = byIdentity.get(decision.action);
          if (declaration === undefined) return decision;
          if (declaration.link !== undefined) {
            const href =
              application === undefined ? undefined : surfaces.link(declaration.link, application);
            return href === undefined
              ? { action: decision.action, eligible: false, reason: "not_permitted" }
              : { action: decision.action, eligible: true, href };
          }
          if (declaration.applicationCapability !== undefined)
            return applicationCapabilityAllowed(
              declaration.applicationCapability,
              application,
              surfaces.capabilities,
            )
              ? { action: decision.action, eligible: true }
              : { action: decision.action, eligible: false, reason: "not_permitted" };
          return decision;
        }),
      };
    }),
  };
};

/**
 * The shared named-action eligibility evaluator decides every named-action-backed command for
 * every visible row in one batch. Flow commands retain the capability decisions from the protected
 * page read. Nothing reads another page, changes a record or exposes business values from an
 * eligibility preview.
 */
export const projectRowActionAvailability = async (
  transaction: RequestDatabaseTransaction,
  installed: RowActionInstallation,
  placementId: string,
  recordTypeId: string,
  projection: RowActions,
): Promise<RowActions> => {
  const named = projection.actions.flatMap((declaration) => {
    if (declaration.eventId === undefined) return [];
    const identity = rowActionIdentity(declaration);
    const action = namedActionFor(installed, placementId, declaration.eventId);
    if (action === undefined) return [];
    if (!sameId(action.subjectRecordTypeId, recordTypeId))
      throw new Error("ROW_ACTION_RECORD_TYPE_MISMATCH");
    return [{ key: identity, action: action.action }];
  });
  if (named.length === 0 || projection.availability.length === 0) return projection;
  const availability = await projectNamedActionAvailability(
    transaction,
    recordTypeId,
    projection.availability.map(({ recordId, revision }) => ({ recordId, revision })),
    named,
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
