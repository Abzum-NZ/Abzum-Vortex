import "server-only";
import {
  HumanOrganizationRequestRestart,
  type BoundHumanOrganizationRequest,
} from "../access/human-organization-request";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import { z } from "zod";
import { jsonValueSchema } from "../catalogue/common";
import { fieldIdSchema } from "../catalogue/identifiers";
import { applyRecordChanges } from "../records/apply-record-changes";
import { revision } from "../records/record-save-preparation";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { FlowOrchestratorDependencies } from "./flow-orchestrator-types";
import type { RecordTypeDefinition } from "./module-contracts";

type FlowRecordChangeTargetReader = NonNullable<
  FlowOrchestratorDependencies["recordChanges"]
>["readTargets"];

/** Reads the targets of a record change under the caller's transaction, locking them on request. */
export const readRecordChangeTargets =
  (transaction: RequestDatabaseTransaction): FlowRecordChangeTargetReader =>
  async (targets, lock = false) => {
    const unique = [
      ...new Map(
        targets.map((target) => [
          `${target.recordTypeId.toLowerCase()}:${target.recordId.toLowerCase()}`,
          target,
        ]),
      ).values(),
    ];
    const rows = await transaction.query<{ ordinal: number; result: unknown }>`
      select ordinal, result from vortex_record.read_record_change_targets(
        ${JSON.stringify(unique)}::text::jsonb, ${lock}::boolean
      ) order by ordinal
    `;
    if (rows.length !== unique.length) throw new Error("FLOW_RECORD_TARGETS_INVALID");
    return rows.flatMap((row, index) => {
      if (row.ordinal !== index + 1 || !isRecord(row.result) || !isRecord(row.result.record))
        throw new Error("FLOW_RECORD_TARGET_INVALID");
      const result = row.result.record;
      if (result.outcome === "refused") return [];
      const current = revision(result.concurrencyNumber);
      const values = z.record(fieldIdSchema, jsonValueSchema).safeParse(result.values);
      const capabilities = z
        .object({ changeableFieldIds: z.array(fieldIdSchema) })
        .safeParse(row.result.capabilities);
      if (
        result.outcome !== "allowed" ||
        current === undefined ||
        !values.success ||
        !capabilities.success
      )
        throw new Error("FLOW_RECORD_TARGET_INVALID");
      return [
        {
          ...unique[index]!,
          revision: current,
          values: values.data,
          changeableFieldIds: capabilities.data.changeableFieldIds,
        },
      ];
    });
  };

/** The admitted segment owns the transaction and rolls back every refused task. */
export const createFlowRecordChangePort = (
  bound: BoundHumanOrganizationRequest,
): NonNullable<FlowOrchestratorDependencies["recordChanges"]> => ({
  readTargets: readRecordChangeTargets(bound.transaction),
  readRevisions: async (targets) => {
    const rows = await bound.transaction.query<{ revisions: unknown }>`
      select vortex_record.read_record_change_revisions(${JSON.stringify(targets)}::text::jsonb) as revisions
    `;
    const revisions = rows[0]?.revisions;
    if (rows.length !== 1 || !Array.isArray(revisions))
      throw new Error("FLOW_RECORD_REVISIONS_INVALID");
    return new Map(
      revisions.map((entry) => {
        const current = isRecord(entry) ? revision(entry.revision) : undefined;
        if (
          !isRecord(entry) ||
          current === undefined ||
          typeof entry.recordTypeId !== "string" ||
          typeof entry.recordId !== "string"
        )
          throw new Error("FLOW_RECORD_REVISIONS_INVALID");
        return [
          `${entry.recordTypeId.toLowerCase()}:${entry.recordId.toLowerCase()}`,
          current,
        ] as const;
      }),
    );
  },
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

/** The release's relationships of one record type, as the record change planners resolve them. */
export const flowRecordTypeRelationships = (recordType: RecordTypeDefinition) =>
  recordType.relationships.map((relationship) => {
    const field = recordType.fields.find((entry) =>
      sameId(entry.fieldId, relationship.fromFieldId),
    );
    if (field === undefined || (field.type !== "link" && field.type !== "link_to_one_of_several"))
      throw new Error("FLOW_RELATIONSHIP_FIELD_INVALID");
    const targets =
      relationship.toRecordType === undefined
        ? relationship.toRecordTypes!
        : [relationship.toRecordType];
    return {
      relationshipId: String(relationship.relationshipId),
      cardinality: relationship.cardinality,
      fromRecordTypeId: String(relationship.fromRecordTypeId),
      fromFieldId: String(relationship.fromFieldId),
      targetRecordTypeIds: targets.map((target) => {
        if (target.state !== "resolved") throw new Error("FLOW_RELATIONSHIP_TARGET_INVALID");
        return String(target.recordTypeId);
      }),
    };
  });
