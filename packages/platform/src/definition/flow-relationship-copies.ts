import { z } from "zod";
import type { JsonValue } from "../catalogue/common";
import { recordIdSchema } from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import { recordChangeListSchema } from "../records/record-change-list";
import { recordLinkValueSchema } from "../records/module-field-values";
import type { RecordChangeIntent } from "../records/apply-record-changes";
import type { FlowRuntimeValues } from "../rules/flow-interpreter";
import type { FlowOrchestratorDependencies, FlowRecordType } from "./flow-orchestrator-types";
import type { FlowRecordTarget, FlowRecordTargetRead } from "./flow-relationship-changes";

const evaluatedCopies = z
  .array(
    recordChangeListSchema.element
      .omit({ subject: true, target: true })
      .extend({ subject: recordIdSchema, target: recordIdSchema }),
  )
  .min(1)
  .max(200);
const key = (target: FlowRecordTarget) =>
  `${target.recordTypeId.toLowerCase()}:${target.recordId.toLowerCase()}`;

/** Merge all copies to a destination before its single BeforeSave evaluation and update. */
export const planRelationshipCopies = async (
  recordTypes: ReadonlyMap<string, FlowRecordType>,
  properties: FlowRuntimeValues,
  read: NonNullable<FlowOrchestratorDependencies["recordChanges"]>["readTargets"],
): Promise<
  | Readonly<{ outcome: "validation" | "refused"; reason?: "relationship_copy_would_replace" }>
  | Readonly<{
      outcome: "planned";
      targets: readonly FlowRecordTargetRead[];
      intents: readonly RecordChangeIntent[];
      outputs: Readonly<{ records: string[] }>;
    }>
> => {
  const changes = evaluatedCopies.safeParse(properties.changes?.value);
  if (!changes.success) return { outcome: "validation" };
  const relationships = [...recordTypes.values()].flatMap((type) => type.relationships);
  const copies = [];
  const requested: FlowRecordTarget[] = [];
  for (const change of changes.data) {
    if (sameId(change.subject, change.target)) return { outcome: "validation" };
    const selected = [];
    for (const relationshipId of new Set(change.relationshipIds.map((id) => id.toLowerCase()))) {
      const matches = relationships.filter((entry) => sameId(entry.relationshipId, relationshipId));
      if (matches.length !== 1 || matches[0]!.cardinality !== "many_to_one")
        return { outcome: "validation" };
      selected.push(matches[0]!);
    }
    const recordTypeId = selected[0]!.fromRecordTypeId;
    if (selected.some((entry) => !sameId(entry.fromRecordTypeId, recordTypeId)))
      return { outcome: "validation" };
    const source = { recordTypeId, recordId: change.subject };
    const target = { recordTypeId, recordId: change.target };
    requested.push(source, target);
    copies.push({ source, target, relationships: selected });
  }
  const records = new Map((await read(requested, true)).map((record) => [key(record), record]));
  const targets = new Map<
    string,
    { record: FlowRecordTargetRead; values: Record<string, JsonValue> }
  >();
  for (const copy of copies) {
    const source = records.get(key(copy.source));
    const target = records.get(key(copy.target));
    if (source === undefined || target === undefined) return { outcome: "refused" };
    const planned = targets.get(key(target)) ?? { record: target, values: {} };
    targets.set(key(target), planned);
    for (const relationship of copy.relationships) {
      const field = relationship.fromFieldId;
      if (
        !Object.hasOwn(source.values, field) ||
        !Object.hasOwn(target.values, field) ||
        !target.changeableFieldIds.some((id) => sameId(id, field))
      )
        return { outcome: "refused" };
      const sourceValue = source.values[field];
      if (sourceValue === null) continue;
      const link = recordLinkValueSchema.safeParse(sourceValue);
      if (!link.success) throw new Error("FLOW_RELATIONSHIP_COPY_SOURCE_INVALID");
      const previous = planned.values[field] ?? target.values[field];
      if (previous !== null) {
        const existing = recordLinkValueSchema.safeParse(previous);
        if (!existing.success) throw new Error("FLOW_RELATIONSHIP_COPY_TARGET_INVALID");
        if (
          !sameId(existing.data.recordTypeId, link.data.recordTypeId) ||
          !sameId(existing.data.recordId, link.data.recordId)
        )
          return { outcome: "refused", reason: "relationship_copy_would_replace" };
        continue;
      }
      planned.values[field] = link.data;
    }
  }
  return {
    outcome: "planned",
    targets: [...targets.values()].map(({ record }) => record),
    intents: [...targets.values()]
      .filter(({ values }) => Object.keys(values).length > 0)
      .map(({ record, values }) => ({
        operation: "update",
        recordTypeId: record.recordTypeId,
        recordId: record.recordId,
        expectedConcurrencyNumber: record.revision,
        values,
      })),
    outputs: { records: [...targets.values()].map(({ record }) => record.recordId) },
  };
};
