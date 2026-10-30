import { z } from "zod";
import { recordIdSchema } from "../catalogue/identifiers";
import {
  executeNamedActionCommandSchema,
  type ExecuteNamedActionCommand,
} from "../records/named-actions";
import type { FlowNamedAction, FlowOrchestratorDependencies } from "./flow-orchestrator-types";

/** The action's typed inputs: a reference input names its record with the type the action declares. */
export const namedActionInputs = (
  named: FlowNamedAction,
  inputs: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      name,
      typeof value === "string" && Object.hasOwn(named.referenceInputTypes, name)
        ? { recordTypeId: named.referenceInputTypes[name], recordId: value }
        : value,
    ]),
  );

const subjectsSchema = z
  .array(
    z.union([
      recordIdSchema.transform((record) => ({ record, revision: undefined })),
      z
        .tuple([recordIdSchema, z.number().int().min(1)])
        .transform(([record, revision]) => ({ record, revision })),
    ]),
  )
  .min(1)
  .max(200);

/**
 * The commands of one named action over the `subjects` of a Call protected operation task: 1 to
 * 200 records, each once, each as a record id alone (changed at the revision it holds now) or as a
 * `[record, revision]` pair with the revision the person saw (the pair keeps a 200-record list
 * within a back-end run's input limit). They run as ONE command: every record completes or none does.
 */
export const planNamedActionSubjects = async (
  recordChanges: FlowOrchestratorDependencies["recordChanges"],
  named: FlowNamedAction,
  commandId: string,
  subjects: unknown,
  inputs: Record<string, unknown>,
): Promise<
  | Readonly<{ commands: readonly ExecuteNamedActionCommand[] }>
  | Readonly<{ outcome: "validation" | "refused" }>
> => {
  const listed = subjectsSchema.safeParse(subjects);
  if (
    !listed.success ||
    new Set(listed.data.map((subject) => subject.record.toLowerCase())).size !== listed.data.length
  )
    return { outcome: "validation" };
  const unversioned = listed.data.filter((subject) => subject.revision === undefined);
  const current =
    unversioned.length === 0
      ? new Map<string, number>()
      : await recordChanges?.readRevisions(
          unversioned.map((subject) => ({
            recordTypeId: named.subjectRecordTypeId,
            recordId: subject.record,
          })),
        );
  if (current === undefined) return { outcome: "refused" };
  const commands = listed.data.map((subject) => {
    const revision =
      subject.revision ??
      current.get(`${named.subjectRecordTypeId.toLowerCase()}:${subject.record.toLowerCase()}`);
    return executeNamedActionCommandSchema.safeParse({
      contractVersion: "2.0.0",
      commandId,
      action: named.action,
      recordTypeId: named.subjectRecordTypeId,
      recordId: subject.record,
      expectedConcurrencyNumber: revision,
      inputs: namedActionInputs(named, inputs),
    });
  });
  if (
    listed.data.some(
      (subject, index) => subject.revision === undefined && !commands[index]!.success,
    )
  )
    return { outcome: "refused" };
  if (!commands.every((command) => command.success)) return { outcome: "validation" };
  return { commands: commands.map((command) => command.data!) };
};
