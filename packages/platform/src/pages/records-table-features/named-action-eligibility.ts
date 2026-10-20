import "server-only";

import { randomUUID } from "node:crypto";
import type { InstalledNamedActionReference } from "../../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../../db/index";
import type { ActionFlowRunner } from "../../rules/index";
import { namedActionPreviewEligibility, type NamedActionEligibility } from "../../records/index";
import { pageSubjectFromRead } from "../page-subject-read";

/** One record of a selection and the identity its command would run with. */
export type NamedActionEligibilityTarget = Readonly<{ recordId: string; commandId: string }>;

/** A selected record's eligibility, with the revision it was decided at when it is readable. */
export type NamedActionRecordEligibility = Readonly<{
  recordId: string;
  revision?: number;
  eligibility: NamedActionEligibility | "removed";
}>;

type EligibilityRow = DatabaseRow & { readonly record_id: string; readonly value: unknown };

/**
 * The batched eligibility of one named action over many records (at most 200): ONE database call
 * reads each record under the caller's current access and previews the action for it with no
 * inputs, writing nothing, inside a transaction the caller already verified. Each preview carries
 * the command identity the record's change would run with, so a record that command already
 * changed reads as replayed. A broad record capability is no proof: every record is decided by the
 * action's own permission and precondition. A record the caller can no longer read is removed.
 */
export const readNamedActionEligibility = async (
  transaction: RequestDatabaseTransaction,
  recordTypeId: string,
  action: InstalledNamedActionReference,
  targets: readonly NamedActionEligibilityTarget[],
  issuedAt: string,
  run: ActionFlowRunner,
): Promise<readonly NamedActionRecordEligibility[]> => {
  if (targets.length === 0) return [];
  if (targets.length > 200) throw new Error("NAMED_ACTION_ELIGIBILITY_BATCH_TOO_LARGE");
  const requests = targets.map((target) => ({
    recordId: target.recordId,
    actions: [
      {
        commandId: target.commandId,
        activityId: randomUUID(),
        ownerKind: action.ownerKind,
        ownerId: action.ownerId,
        releaseRevision: action.releaseRevision,
        actionId: action.actionId,
      },
    ],
  }));
  let rows: readonly EligibilityRow[];
  await transaction.query`set local role vortex_runtime`;
  try {
    rows = await transaction.query<EligibilityRow>`
      select target.value ->> 'recordId' as record_id,
        vortex_record.read_record_with_action_previews(
          ${recordTypeId}::uuid, (target.value ->> 'recordId')::uuid,
          target.value -> 'actions', null::jsonb
        ) as value
      from pg_catalog.jsonb_array_elements(${JSON.stringify(requests)}::text::jsonb) as target(value)
    `;
  } finally {
    await transaction.query`set local role vortex_request`;
  }
  if (rows.length !== targets.length) throw new Error("NAMED_ACTION_ELIGIBILITY_ROWS_MISSING");
  return rows.map((row): NamedActionRecordEligibility => {
    if (typeof row.value !== "object" || row.value === null)
      throw new Error("NAMED_ACTION_ELIGIBILITY_RESULT_INVALID");
    const read = row.value as Record<string, unknown>;
    const subject = pageSubjectFromRead(read.record, read.capabilities, row.record_id);
    if (subject.kind !== "read") return { recordId: row.record_id, eligibility: "removed" };
    const previews = Array.isArray(read.previews) ? (read.previews as unknown[]) : [];
    const entry = previews[0] as Record<string, unknown> | undefined;
    if (entry === undefined) throw new Error("NAMED_ACTION_ELIGIBILITY_PREVIEW_MISSING");
    return {
      recordId: row.record_id,
      ...(subject.row.revision === undefined ? {} : { revision: subject.row.revision }),
      eligibility: namedActionPreviewEligibility(entry.preview, issuedAt, run),
    };
  });
};
