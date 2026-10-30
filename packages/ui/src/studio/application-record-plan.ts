import type { SourceFlow } from "@vortex/platform/schema";
import { applyStudioFlowCreate, type StudioFlowCreateCommand } from "./application-flow-create";
import { judged, quoted, refuse, uniqueKey, type Source } from "./application-structure-common";

/** A plan being written: the draft so far, the words describing it, and fresh aliases. */
export type Plan = { source: Source; details: string[]; taken: Set<string> };
export const freshAlias = (plan: Plan, base: string): string => {
  const alias = uniqueKey(base, "", plan.taken, 160);
  plan.taken.add(alias);
  return alias;
};

/** Creates one flow bound to a control, or binds one more control to it, by the one flow-create path. */
export const flowCreate = (
  plan: Plan,
  command: StudioFlowCreateCommand,
  what: string,
): Readonly<{ id: string; eventId: string; flowKey: string }> => {
  const result = applyStudioFlowCreate(judged(plan.source), command, null);
  if (result.kind === "refused") return refuse(`${what} could not be made: ${result.reason}`);
  plan.source = result.source;
  return { ...result.binding!, flowKey: result.selection.flowAlias };
};

/** The parts of a flow the one flow-create command takes, from a default flow builder's source. */
export const flowParts = (
  { description, inputs, tasks, outputs, errors }: SourceFlow,
  name: string,
) => ({
  name,
  description: description ?? "",
  inputs,
  tasks,
  outputs,
  ...(errors.length === 0 ? {} : { errors }),
});

/** Binds a control event to a flow made from a default flow builder's source; the binding carries each flow input by name. */
export const bindDefault = (
  plan: Plan,
  controlAlias: string,
  event: "action" | "row_clicked" | "row_action" | "form_submit",
  flow: SourceFlow,
  name: string,
  extra: Readonly<{
    rowActionLabel?: string;
    rowActionCapability?: "update" | "delete" | "restore";
  }> = {},
) =>
  flowCreate(
    plan,
    {
      kind: "control",
      controlAlias,
      event,
      ...flowParts(flow, name),
      bindingInputs: Object.fromEntries(
        Object.keys(flow.inputs).map((input) => [input, { kind: "caller" as const, name: input }]),
      ),
      ...extra,
    },
    `The flow ${quoted(name)}`,
  );
