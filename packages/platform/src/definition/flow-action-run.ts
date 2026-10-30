import "server-only";

import type { JsonValue } from "../catalogue/common";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { RecordChangeIntent } from "../records/apply-record-changes";
import { recordTypeIdSchema } from "../catalogue/identifiers";
import type { FlowLibrary, FlowProtectedTaskCall } from "../rules/flow-interpreter";
import { runTransactionFlow, type TransactionFlowSeed } from "../rules/transaction-flow-run";
import type { FlowRecordType } from "./flow-orchestrator-types";
import { nameRecordValues, setsActionOwnedOption, withoutEmptyValues } from "./flow-record-values";
import { readRecordChangeTargets } from "./flow-record-changes";
import { planRelationshipCopies } from "./flow-relationship-copies";

/** The record a named action runs on, at the revision its command names. */
type NamedActionSubject = Readonly<{
  recordTypeId: string;
  recordId: string;
  revision: number;
}>;

type NamedActionFlowOutcome =
  /** The record changes the flow asks for, in one list for the one `apply_record_changes` call. */
  | Readonly<{ kind: "planned"; intents: readonly RecordChangeIntent[] }>
  /** The run could not be started or finished, or a step cannot be planned. */
  | Readonly<{ kind: "invalid"; reason: string }>;

/**
 * Runs a named action's flow for one subject inside the transaction its caller owns and plans the
 * record steps it asked for. The caller applies every intent in one call.
 */
export type NamedActionFlowRunner = (
  seed: TransactionFlowSeed,
  subject: NamedActionSubject,
  transaction: RequestDatabaseTransaction,
) => Promise<NamedActionFlowOutcome>;

const invalid = (reason: string): NamedActionFlowOutcome =>
  Object.freeze({ kind: "invalid", reason });

const valueMap = (
  call: FlowProtectedTaskCall,
  property: string,
): Readonly<Record<string, unknown>> | undefined => {
  const carried = call.properties[property]?.value;
  return isRecord(carried) ? carried : undefined;
};

/** Whether a step that may name its record and record type names the action's subject. */
const namesSubject = (call: FlowProtectedTaskCall, subject: NamedActionSubject): boolean => {
  const recordType = call.properties.record_type?.value;
  const record = call.properties.record?.value;
  return (
    (recordType === undefined ||
      (typeof recordType === "string" && sameId(recordType, subject.recordTypeId))) &&
    (record === undefined || (typeof record === "string" && sameId(record, subject.recordId)))
  );
};

/**
 * Plans the record steps of an action flow the way every flow plans them: values named by the
 * release's field keys, creations through the writer's create path, relationship copies by the
 * shared copy planner, the subject changed or deleted at the revision the command names. An action
 * flow is a linear list of these steps; its Events are announced by the writer.
 */
const planActionRecordSteps = async (
  calls: readonly FlowProtectedTaskCall[],
  subject: NamedActionSubject,
  recordTypes: ReadonlyMap<string, FlowRecordType>,
  read: ReturnType<typeof readRecordChangeTargets>,
): Promise<NamedActionFlowOutcome> => {
  const subjectType = recordTypes.get(subject.recordTypeId.toLowerCase());
  if (subjectType === undefined) return invalid("the action's record type is not in the release");
  const subjectValues: Record<string, JsonValue> = {};
  const creations: RecordChangeIntent[] = [];
  const copies: RecordChangeIntent[] = [];
  const copiedFieldIds = new Set<string>();
  let deletesSubject = false;

  for (const call of calls) {
    if (call.taskType === "event.announce") continue;
    if (call.taskType === "record.set_fields") {
      const values = valueMap(call, "values");
      const named = values === undefined ? undefined : nameRecordValues(subjectType, values);
      if (named === undefined || !namesSubject(call, subject))
        return invalid(`step ${call.taskId} does not set fields of the record the action runs on`);
      Object.assign(subjectValues, named.submittedValues);
      continue;
    }
    if (call.taskType === "record.create") {
      const recordTypeId = recordTypeIdSchema.safeParse(call.properties.record_type?.value);
      const recordType = recordTypeId.success
        ? recordTypes.get(recordTypeId.data.toLowerCase())
        : undefined;
      const values = valueMap(call, "values");
      const named =
        recordType === undefined || values === undefined
          ? undefined
          : nameRecordValues(recordType, values);
      if (!recordTypeId.success || recordType === undefined || named === undefined)
        return invalid(`step ${call.taskId} does not name a record type and fields to create`);
      const created = withoutEmptyValues(named.submittedValues);
      if (setsActionOwnedOption(recordType, created))
        return invalid(`step ${call.taskId} creates a record in a state only an action may set`);
      creations.push({ operation: "create", recordTypeId: recordTypeId.data, values: created });
      continue;
    }
    if (call.taskType === "record.delete") {
      if (
        deletesSubject ||
        call.properties.record_type?.value === undefined ||
        call.properties.record?.value === undefined ||
        !namesSubject(call, subject)
      )
        return invalid(`step ${call.taskId} does not delete the record the action runs on`);
      deletesSubject = true;
      continue;
    }
    if (call.taskType === "record.changes") {
      const changes = call.properties.changes?.value;
      const copiedRelationshipIds: string[] = [];
      for (const change of Array.isArray(changes) ? changes : []) {
        if (
          !isRecord(change) ||
          typeof change.subject !== "string" ||
          !sameId(change.subject, subject.recordId) ||
          !Array.isArray(change.relationshipIds)
        )
          return invalid(
            `step ${call.taskId} copies relationships of a record other than the subject`,
          );
        for (const relationshipId of change.relationshipIds)
          if (typeof relationshipId === "string") copiedRelationshipIds.push(relationshipId);
      }
      const planned = await planRelationshipCopies(recordTypes, call.properties, read);
      if (planned.outcome !== "planned")
        return invalid(
          `step ${call.taskId} could not plan its relationship copies (${planned.reason ?? planned.outcome})`,
        );
      for (const relationshipId of copiedRelationshipIds) {
        const relationship = subjectType.relationships.find((entry) =>
          sameId(entry.relationshipId, relationshipId),
        );
        if (relationship === undefined)
          return invalid(`step ${call.taskId} copies a relationship the subject does not have`);
        copiedFieldIds.add(relationship.fromFieldId.toLowerCase());
      }
      for (const intent of planned.intents) {
        if (
          intent.operation !== "update" ||
          copies.some(
            (other) => other.operation === "update" && sameId(other.recordId, intent.recordId),
          )
        )
          return invalid(`step ${call.taskId} copies onto a record another step already changes`);
        copies.push(intent);
      }
      continue;
    }
    return invalid(`step ${call.taskId} of type ${call.taskType} cannot run in an action flow`);
  }

  const writesSubject = Object.keys(subjectValues).length > 0;
  // A copy reads the subject's link as it stands before the command writes the subject.
  if (Object.keys(subjectValues).some((fieldId) => copiedFieldIds.has(fieldId.toLowerCase())))
    return invalid("the flow sets a link field that it also copies");
  // The delete runs at the revision the command names, so nothing may move it first.
  if (deletesSubject && (writesSubject || creations.length > 0))
    return invalid("the flow deletes the record it also changes or creates from");
  return Object.freeze({
    kind: "planned",
    intents: [
      ...(deletesSubject
        ? [
            {
              operation: "delete" as const,
              recordTypeId: subject.recordTypeId,
              recordId: subject.recordId,
              expectedConcurrencyNumber: subject.revision,
            },
          ]
        : writesSubject
          ? [
              {
                operation: "update" as const,
                recordTypeId: subject.recordTypeId,
                recordId: subject.recordId,
                expectedConcurrencyNumber: subject.revision,
                values: subjectValues,
              },
            ]
          : []),
      ...creations,
      ...copies,
    ],
  });
};

/** The runner of one installed named action's flow; both the button and a bulk run call it. */
export const namedActionFlowRunner =
  (
    library: FlowLibrary,
    recordTypes: ReadonlyMap<string, FlowRecordType>,
    flowId: string,
    runId: string,
  ): NamedActionFlowRunner =>
  async (seed, subject, transaction) => {
    const outcome = runTransactionFlow(library, flowId, runId, seed);
    return outcome.kind === "collected"
      ? planActionRecordSteps(
          outcome.calls,
          subject,
          recordTypes,
          readRecordChangeTargets(transaction),
        )
      : outcome;
  };
