import "server-only";

import { randomUUID } from "node:crypto";
import type { ExecuteNamedActionCommand } from "./named-actions";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { actionPreconditionHolds } from "./named-action-inputs";
import {
  one,
  parsePreparation,
  type ActionPreparation,
  type ResultRow,
} from "./action-record-preparation";

/** Whether a named action can run on one record for the viewer, as a page asks before it shows a control. */
export type NamedActionAvailability =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "refused"; cause: "precondition" | "permission" }>
  /** The preview cannot decide without the inputs the person has yet to supply; submit decides. */
  | Readonly<{ kind: "undecided"; reason: string }>;

const availabilityFromPreview = (preview: ActionPreparation): NamedActionAvailability => {
  if (preview.outcome === "permission_refused") return { kind: "refused", cause: "permission" };
  if (preview.outcome !== "previewed") {
    const reasonCode = "reasonCode" in preview ? preview.reasonCode : undefined;
    return {
      kind: "undecided",
      reason: `the preview was ${preview.outcome}, not previewed (${reasonCode ?? "no reason code"})`,
    };
  }
  const holds = actionPreconditionHolds(preview, {});
  if (holds === undefined)
    return { kind: "undecided", reason: "the precondition compares with inputs not supplied yet" };
  return holds ? { kind: "available" } : { kind: "refused", cause: "precondition" };
};

/** Whether a named action can run on one selected record now, as a bulk run decides it. */
export type NamedActionEligibility =
  | "eligible"
  /** The same command already completed on the record: running it again replays that change. */
  | "replayed"
  | "not_applicable"
  | "not_permitted"
  | "changed"
  | "refused";

/** Decides one record's eligibility from its action preview (no inputs), writing nothing. */
export const namedActionPreviewEligibility = (
  previewCandidate: unknown,
): NamedActionEligibility => {
  const preview = parsePreparation(previewCandidate);
  if (preview.outcome === "completed") return "replayed";
  if (preview.outcome === "permission_refused") return "not_permitted";
  if (preview.outcome === "conflict") return "changed";
  if (preview.outcome !== "previewed") return "refused";
  const holds = actionPreconditionHolds(preview, {});
  return holds === undefined ? "refused" : holds ? "eligible" : "not_applicable";
};

/** A page subject read together with the availability of every named action bound to it. */
type SubjectWithNamedActionAvailability = Readonly<{
  /** The subject projection and capabilities, as `vortex_record.read_record` returns them. */
  record: unknown;
  capabilities: unknown;
  /** Keyed by lower-case action id; empty when the subject is not readable. */
  availability: ReadonlyMap<string, NamedActionAvailability>;
}>;

/**
 * Reads a page subject and previews every named action its placements are bound to in one fixed
 * adapter call: one read decision for the record, and each action's own preview for the record's
 * current concurrency number with no inputs, inside a transaction the caller already verified.
 * Nothing is written. A subject the viewer
 * cannot read previews nothing.
 */
export const readSubjectWithNamedActionAvailability = async (
  transaction: RequestDatabaseTransaction,
  subject: Readonly<{
    recordTypeId: string;
    recordId: string;
    requestedFieldIds: readonly string[] | null;
  }>,
  actions: readonly ExecuteNamedActionCommand["action"][],
): Promise<SubjectWithNamedActionAvailability> => {
  const requests = actions.map((action) => ({
    commandId: randomUUID(),
    ownerKind: action.ownerKind,
    ownerId: action.ownerId,
    releaseRevision: action.releaseRevision,
    actionId: action.actionId,
  }));
  const rows = await transaction.query<ResultRow>`
    select vortex_record.read_record_with_action_previews(
      ${subject.recordTypeId}::uuid, ${subject.recordId}::uuid,
      ${JSON.stringify(requests)}::text::jsonb,
      ${subject.requestedFieldIds === null ? null : JSON.stringify(subject.requestedFieldIds)}::text::jsonb
    ) as value
  `;
  const value = one(rows).value;
  if (typeof value !== "object" || value === null)
    throw new Error("NAMED_ACTION_PREVIEWS_RESULT_INVALID");
  const read = value as Record<string, unknown>;
  const previews = Array.isArray(read.previews) ? (read.previews as unknown[]) : undefined;
  if (previews === undefined) throw new Error("NAMED_ACTION_PREVIEWS_RESULT_INVALID");
  const availability = new Map<string, NamedActionAvailability>();
  for (const action of actions) {
    const key = action.actionId.toLowerCase();
    if (availability.has(key)) continue;
    const entry = previews.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        String((item as Record<string, unknown>).actionId).toLowerCase() === key,
    ) as Record<string, unknown> | undefined;
    if (entry === undefined) {
      if ((read.record as Record<string, unknown> | null)?.outcome === "allowed")
        throw new Error("NAMED_ACTION_PREVIEW_MISSING");
      continue;
    }
    availability.set(key, availabilityFromPreview(parsePreparation(entry.preview)));
  }
  return { record: read.record, capabilities: read.capabilities, availability };
};
