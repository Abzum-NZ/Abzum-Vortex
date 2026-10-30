import "server-only";
import {
  HumanOrganizationRequestRestart,
  type BoundHumanOrganizationRequest,
} from "../access/human-organization-request";
import { isRecord } from "../catalogue/runtime-primitives";
import { applyRecordChanges } from "../records/apply-record-changes";
import { revision } from "../records/record-save-preparation";
import type { FlowOrchestratorDependencies } from "./flow-orchestrator-types";

/** The admitted segment owns the transaction and rolls back every refused task. */
export const createFlowRecordChangePort = (
  bound: BoundHumanOrganizationRequest,
): NonNullable<FlowOrchestratorDependencies["recordChanges"]> => ({
  apply: async (commandId, intents) => {
    const result = await applyRecordChanges(bound.transaction, bound.issuedAt, commandId, intents);
    if (result.kind === "restart") throw new HumanOrganizationRequestRestart();
    return result;
  },
  restoreRevision: async (recordTypeId, recordId) => {
    const rows = await bound.transaction.query<{ result: unknown }>`
      select vortex_record.prepare_record_restore_target(${recordTypeId}::uuid, ${recordId}::uuid) as result
    `;
    if (rows.length !== 1 || !isRecord(rows[0]?.result))
      throw new Error("FLOW_RESTORE_TARGET_INVALID");
    const result = rows[0].result;
    if (result.outcome === "unavailable") return undefined;
    const current = revision(result.concurrencyNumber);
    if (result.outcome !== "allowed" || current === undefined)
      throw new Error("FLOW_RESTORE_TARGET_INVALID");
    return current;
  },
});
