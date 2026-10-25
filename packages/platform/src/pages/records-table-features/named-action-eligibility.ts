import "server-only";

import { randomUUID } from "node:crypto";
import type { InstalledNamedActionReference } from "../../records/named-actions";
import type { RequestDatabaseTransaction } from "../../db/request-transaction";
import type { ActionFlowRunner } from "../../rules/action-flow-run";
import {
  namedActionPreviewEligibility,
  type NamedActionEligibility,
} from "../../records/action-record-availability";
import { readableSubjectFromProjection } from "../page-subject-read";

/** One record of a selection and the identity its command would run with. */
export type NamedActionEligibilityTarget = Readonly<{ recordId: string; commandId: string }>;

/** A selected record's eligibility, with the revision it was decided at when it is readable. */
export type NamedActionRecordEligibility = Readonly<{
  recordId: string;
  revision?: number;
  actions: readonly Readonly<{
    actionId: string;
    eligibility: NamedActionEligibility | "removed";
  }>[];
}>;

export type NamedActionEligibilityAction = Readonly<{
  action: InstalledNamedActionReference;
  run: ActionFlowRunner;
}>;

type EligibilityRow = Readonly<{ recordId: string; record: unknown; previews: unknown }>;

/**
 * The batched eligibility of declared named actions over many records (at most 200): ONE database call
 * reads the records together through the page read pass under the caller's current access and
 * previews the action for each readable one with no inputs, writing nothing, inside a transaction
 * the caller already verified. Each preview carries
 * the command identity the record's change would run with, so a record that command already
 * changed reads as replayed. A broad record capability is no proof: every record is decided by the
 * action's own permission and precondition. A record the caller can no longer read is removed.
 */
export const readNamedActionEligibility = async (
  transaction: RequestDatabaseTransaction,
  recordTypeId: string,
  actions: readonly NamedActionEligibilityAction[],
  targets: readonly NamedActionEligibilityTarget[],
  issuedAt: string,
): Promise<readonly NamedActionRecordEligibility[]> => {
  if (targets.length === 0) return [];
  if (targets.length > 200) throw new Error("NAMED_ACTION_ELIGIBILITY_BATCH_TOO_LARGE");
  if (actions.length === 0 || actions.length > 20)
    throw new Error("NAMED_ACTION_ELIGIBILITY_ACTIONS_INVALID");
  const requests = targets.map((target) => ({
    recordId: target.recordId,
    actions: actions.map(({ action }) => ({
      commandId: target.commandId,
      activityId: randomUUID(),
      ownerKind: action.ownerKind,
      ownerId: action.ownerId,
      releaseRevision: action.releaseRevision,
      actionId: action.actionId,
    })),
  }));
  await transaction.query`set local role vortex_runtime`;
  // A failed read aborts the transaction, so the role reset would fail too and replace the real
  // cause; it runs only after a read that succeeded (the aborted transaction is rolled back).
  const [result] = await transaction.query<{ readonly value: unknown }>`
    select vortex_record.read_records_with_action_previews(
      ${recordTypeId}::uuid, ${JSON.stringify(requests)}::text::jsonb
    ) as value
  `;
  await transaction.query`set local role vortex_request`;
  if (!Array.isArray(result?.value)) throw new Error("NAMED_ACTION_ELIGIBILITY_RESULT_INVALID");
  const rows = result.value as readonly EligibilityRow[];
  if (rows.length !== targets.length) throw new Error("NAMED_ACTION_ELIGIBILITY_ROWS_MISSING");
  const byId = new Map(rows.map((row) => [row.recordId.toLowerCase(), row]));
  if (byId.size !== targets.length) throw new Error("NAMED_ACTION_ELIGIBILITY_ROWS_DUPLICATED");
  return targets.map((target): NamedActionRecordEligibility => {
    const row = byId.get(target.recordId.toLowerCase());
    if (row === undefined) throw new Error("NAMED_ACTION_ELIGIBILITY_ROW_MISSING");
    const subject = readableSubjectFromProjection(row.record, row.recordId);
    if (!Array.isArray(row.previews)) throw new Error("NAMED_ACTION_ELIGIBILITY_PREVIEWS_INVALID");
    const previews = row.previews as unknown[];
    if (previews.length !== (subject.kind === "readable" ? actions.length : 0))
      throw new Error("NAMED_ACTION_ELIGIBILITY_PREVIEWS_INVALID");
    return {
      recordId: row.recordId,
      ...(subject.kind === "readable" ? { revision: subject.subject.concurrencyNumber } : {}),
      actions: actions.map(({ action, run }, index) => {
        if (subject.kind !== "readable")
          return { actionId: action.actionId, eligibility: "removed" };
        const entry = previews[index];
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("actionId" in entry) ||
          String(entry.actionId).toLowerCase() !== action.actionId.toLowerCase() ||
          !("preview" in entry)
        )
          throw new Error("NAMED_ACTION_ELIGIBILITY_PREVIEW_INVALID");
        return {
          actionId: action.actionId,
          eligibility: namedActionPreviewEligibility(entry.preview, issuedAt, run),
        };
      }),
    };
  });
};
