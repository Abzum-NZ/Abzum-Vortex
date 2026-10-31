import type {
  ApplicationSourceDocument,
  flowStandardEventKindSchema,
  SourceFlow,
} from "@vortex/platform/schema";
import { studioFlowKeyFrom as keyFrom } from "./application-flow-model";

/**
 * A back-end flow of a record type: with an event it is a subscriber that runs after every such
 * change of a record, without one it is a target another flow runs on the back end. It lives in
 * the module that owns the record type, or among the application's flows when moduleKey is null
 * (an application flow names its record types as module:key, a module's flow by key).
 */
export type StudioBackgroundFlowCommand = Readonly<{
  kind: "background";
  moduleKey: string | null;
  recordTypeKey: string;
  name: string;
  event: (typeof flowStandardEventKindSchema.options)[number] | null;
}>;

/** Adds the flow to the draft body in place; the reason when it cannot be added. */
export const addStudioBackgroundFlow = (
  body: ApplicationSourceDocument["body"],
  command: StudioBackgroundFlowCommand,
  name: string,
): Readonly<{ flow: SourceFlow; moduleKey: string | null }> | string => {
  const module =
    command.moduleKey === null
      ? undefined
      : body.modules.find((entry) => entry.key === command.moduleKey);
  if (command.moduleKey !== null && module === undefined)
    return "This application does not own that module, so it cannot hold a flow for it.";
  const recordTypeId = command.recordTypeKey;
  const known =
    module === undefined
      ? body.modules.some((entry) =>
          entry.record_types.some((record) => `${entry.key}:${record.key}` === recordTypeId),
        )
      : module.record_types.some((record) => record.key === recordTypeId);
  if (!known) return "That record type is not in this application.";
  const flows = module === undefined ? body.flows : module.flows;
  const key = keyFrom(name, new Set(flows.flatMap((entry) => [entry.id, entry.key])));
  if (key === undefined) return "No free name could be made for this flow. Choose another name.";
  const flow: SourceFlow = {
    id: key,
    key,
    labels: { name },
    execution: "background",
    runAs: { kind: "initiator" },
    // A subscriber receives the record its event is about in the record input a started flow
    // names its record in, so a step can point at the record itself.
    ...(command.event === null ? {} : { recordInput: "record" }),
    inputs: {
      record: {
        type: "record_reference",
        required: true,
        recordTypeIds: [recordTypeId],
        description:
          command.event === null
            ? "The record the flow runs on."
            : "The record the event is about.",
      },
    },
    variables: {},
    outputs: {},
    errors: [],
    finally: [],
    triggers:
      command.event === null
        ? []
        : [
            {
              id: "after_save",
              type: "Event",
              recordTypeId,
              inputs: {},
              event: { kind: "standard", eventKind: command.event },
              duplicateProtection: "committed_occurrence",
            },
          ],
    tasks: [{ id: "done", type: "stop", outcome: "completed" }],
  };
  flows.push(flow);
  return { flow, moduleKey: module?.key ?? null };
};
