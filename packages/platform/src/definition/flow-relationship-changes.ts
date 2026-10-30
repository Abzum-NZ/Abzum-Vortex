import type { JsonValue } from "../catalogue/common";
import { containedComponentIdSchema, recordIdSchema } from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import { recordLinkValueSchema } from "../records/module-field-values";
import { relationshipReference } from "../records/relationship-reference";
import type { RecordChangeIntent } from "../records/apply-record-changes";
import type { FlowRuntimeValues } from "../rules/flow-interpreter";
import type { FlowOrchestratorDependencies, FlowRecordType } from "./flow-orchestrator-types";

export type FlowRecordTarget = Readonly<{ recordTypeId: string; recordId: string }>;
export type FlowRecordTargetRead = FlowRecordTarget &
  Readonly<{
    revision: number;
    values: Readonly<Record<string, JsonValue>>;
    changeableFieldIds: readonly string[];
  }>;

/** Resolve a declared link into the same field update used by forms and named actions. */
export const planRecordLink = async (
  recordTypes: ReadonlyMap<string, FlowRecordType>,
  properties: FlowRuntimeValues,
  read: NonNullable<FlowOrchestratorDependencies["recordChanges"]>["readTargets"],
): Promise<
  | Readonly<{ outcome: "validation" | "refused"; reason?: "relationship_already_linked" }>
  | Readonly<{
      outcome: "planned";
      subject: FlowRecordTargetRead;
      intents: readonly RecordChangeIntent[];
      outputs: Readonly<{ relationship: string }>;
    }>
> => {
  const relationshipId = containedComponentIdSchema.safeParse(properties.relationship?.value);
  const subjectId = recordIdSchema.safeParse(properties.subject?.value);
  const targetId = recordIdSchema.safeParse(properties.target?.value);
  if (!relationshipId.success || !subjectId.success || !targetId.success)
    return { outcome: "validation" };
  const declarations = [...recordTypes.values()]
    .flatMap((type) => type.relationships)
    .filter((entry) => sameId(entry.relationshipId, relationshipId.data));
  if (declarations.length !== 1) return { outcome: "validation" };
  const relationship = declarations[0]!;
  const candidates: FlowRecordTarget[] = [
    { recordTypeId: relationship.fromRecordTypeId, recordId: subjectId.data },
    ...relationship.targetRecordTypeIds.map((recordTypeId) => ({
      recordTypeId,
      recordId: targetId.data,
    })),
  ];
  const records = await read(candidates);
  const subject = records.find(
    (entry) =>
      sameId(entry.recordTypeId, relationship.fromRecordTypeId) &&
      sameId(entry.recordId, subjectId.data),
  );
  const targets = records.filter(
    (entry) =>
      sameId(entry.recordId, targetId.data) &&
      relationship.targetRecordTypeIds.some((id) => sameId(id, entry.recordTypeId)),
  );
  if (
    subject === undefined ||
    targets.length !== 1 ||
    !subject.changeableFieldIds.some((id) => sameId(id, relationship.fromFieldId)) ||
    !Object.hasOwn(subject.values, relationship.fromFieldId)
  )
    return { outcome: "refused" };
  const target = targets[0]!;
  const previous = subject.values[relationship.fromFieldId];
  const existing = previous === null ? undefined : recordLinkValueSchema.safeParse(previous);
  if (existing !== undefined && !existing.success)
    throw new Error("FLOW_RELATIONSHIP_VALUE_INVALID");
  if (
    existing?.success &&
    (!sameId(existing.data.recordTypeId, target.recordTypeId) ||
      !sameId(existing.data.recordId, target.recordId))
  )
    return { outcome: "refused", reason: "relationship_already_linked" };
  const reference = relationshipReference({
    relationshipId: relationship.relationshipId,
    sourceRecordId: subject.recordId,
  });
  if (reference === undefined) throw new Error("FLOW_RELATIONSHIP_REFERENCE_INVALID");
  return {
    outcome: "planned",
    subject,
    intents: existing?.success
      ? []
      : [
          {
            operation: "update",
            recordTypeId: subject.recordTypeId,
            recordId: subject.recordId,
            expectedConcurrencyNumber: subject.revision,
            values: {
              [relationship.fromFieldId]: {
                recordTypeId: target.recordTypeId,
                recordId: target.recordId,
              },
            },
          },
        ],
    outputs: { relationship: reference.value },
  };
};
