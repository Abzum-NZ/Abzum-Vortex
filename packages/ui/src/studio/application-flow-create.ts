import {
  applicationSourceDocumentSchema,
  builderKeySchema,
  flowContractVersion,
  sourcePageItems,
  validateFlow,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceFlow,
} from "@vortex/platform/schema";
import { describeStudioFlowLocation, studioWords } from "./application-flow-model";
import { traverseStudioSemanticSelectionDraft, type StudioSemanticSelection } from "./semantic-selection";

/**
 * Creating a flow and binding it, the one way flows are created and bound:
 * - for an action: an interactive flow started by the person, with one Show message step, and one
 *   flow binding of the control's action event to it (the existing `flow_bindings` model);
 * - for a control event with its steps given (a generated page's Open, New, Edit and Save): an
 *   interactive flow with exactly those inputs, steps and outputs, bound to that control event;
 * - for another control of an existing flow (each form of a guided form): one more binding;
 * - for a record event: a transaction flow an owned Module runs before one of its record types is
 *   saved, with one Warn step (the trigger is the flow's own `triggers`, as Module rules have).
 * A binding of a control on a page of a record type declares its event for that record type, as
 * publication requires of every bound event.
 */

type SourceBinding = ApplicationSourceDocument["body"]["flow_bindings"][number];
/** A control event a flow can be bound to. */
export type StudioFlowControlEvent = SourceBinding["event"];

export type StudioFlowCreateCommand =
  | Readonly<{ kind: "action"; controlAlias: string; name: string }>
  | Readonly<{ kind: "control"; controlAlias: string; event: StudioFlowControlEvent; name: string; description: string;
      inputs: SourceFlow["inputs"]; tasks: SourceFlow["tasks"]; outputs: SourceFlow["outputs"];
      bindingInputs: SourceBinding["inputs"] }>
  | Readonly<{ kind: "bind"; controlAlias: string; event: StudioFlowControlEvent; flowKey: string;
      bindingInputs: SourceBinding["inputs"] }>
  | Readonly<{ kind: "before_save"; moduleKey: string; recordTypeKey: string; name: string;
      operations: readonly ("create" | "update")[] }>;

export type StudioFlowCreateResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument; selection: Extract<StudioSemanticSelection, { kind: "flow" }>;
      /** The binding made, for a command that binds a control: its alias and the event it declares. */
      binding?: Readonly<{ id: string; eventId: string }> }>
  | Readonly<{ kind: "refused"; reason: string }>;

export type StudioFlowCreateChoices = Readonly<{
  /** Controls that raise an action and have no flow bound to it yet. */
  actions: readonly Readonly<{ controlAlias: string; label: string }>[];
  /** Record types of the Modules this application owns. */
  recordTypes: readonly Readonly<{ moduleKey: string; moduleName: string; recordTypeKey: string; label: string }>[];
}>;

export const projectStudioFlowCreateChoices = (
  draft: Readonly<{ rootId: Parameters<typeof traverseStudioSemanticSelectionDraft>[0]["rootId"];
    source: ApplicationSourceDocument; catalogue: ImmutablePlatformBlockCatalogue }>,
  controlLabel: (alias: string) => string,
): StudioFlowCreateChoices => {
  const bound = new Set(draft.source.body.flow_bindings.filter((binding) => binding.event === "action")
    .map((binding) => binding.control));
  const actions: { controlAlias: string; label: string }[] = [];
  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase !== "enter" || node.kind !== "placement" || bound.has(node.selection.placementAlias)) return;
    const release = draft.catalogue.releases.find((candidate) => String(candidate.blockId) === node.block.block_id &&
      String(candidate.releaseVersion) === node.block.release_version);
    if (release?.supportedEvents.includes("action") === true)
      actions.push({ controlAlias: node.selection.placementAlias, label: controlLabel(node.selection.placementAlias) });
  });
  const recordTypes = draft.source.body.modules.flatMap((module) => module.record_types.map((recordType) => ({
    moduleKey: module.key, moduleName: module.name, recordTypeKey: recordType.key,
    label: "name" in recordType && typeof recordType.name === "string" ? recordType.name : studioWords(recordType.key),
  })));
  return { actions, recordTypes };
};

/** A builder key from a name, unique among the taken ones. */
const keyFrom = (name: string, taken: ReadonlySet<string>): string | undefined => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 34).replace(/_+$/g, "") || "flow";
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate) && builderKeySchema.safeParse(candidate).success) return candidate;
  }
  return undefined;
};

const message = (value: string) => ({ kind: "literal" as const, literal: { type: "text" as const, value } });

class FlowCreateRefusal extends Error {}
const refuse = (reason: string): never => { throw new FlowCreateRefusal(reason); };

/**
 * Binds one control event to a flow: a fresh binding alias and event alias, and, for a control on
 * a page of a record type, the event's declaration for that record type.
 */
const bindControl = (body: ApplicationSourceDocument["body"], controlAlias: string, event: StudioFlowControlEvent,
  flowKey: string, inputs: SourceBinding["inputs"]): Readonly<{ id: string; eventId: string }> => {
  if (body.flow_bindings.some((binding) => binding.control === controlAlias && binding.event === event))
    refuse(event === "action" ? "This control already runs a flow when it is used. Open that flow and change it instead."
      : "This control already runs a flow for that event. Open that flow and change it instead.");
  const aliases = new Set([...body.flow_bindings.flatMap((binding) => [binding.id, binding.event_id]),
    ...body.events.map((entry) => entry.id)]);
  const id = keyFrom(`binding_${flowKey}`, aliases);
  const eventId = keyFrom(`event_${flowKey}`, aliases);
  if (id === undefined || eventId === undefined) return refuse("No free name could be made for the binding. Choose another name.");
  const page = body.pages.find((candidate) => sourcePageItems(candidate.composition).some((item) => item.props.id === controlAlias));
  if (page !== undefined && "record_type" in page && typeof page.record_type === "string") {
    if (body.events.length >= 100) refuse("An application can declare at most 100 events, so no more controls can be bound.");
    body.events.push({ id: eventId, key: `vortex.app.events.${eventId}`, record_type: page.record_type, carries: [],
      personal_or_sensitive_values_allowed: false });
  }
  body.flow_bindings.push({ id, control: controlAlias, event_id: eventId, event, flow: flowKey, inputs });
  return { id, eventId };
};

const interactiveFlow = (key: string, name: string, parts: Pick<SourceFlow, "inputs" | "tasks" | "outputs"> &
  Readonly<{ description?: string }>): SourceFlow => ({
  contractVersion: flowContractVersion, id: key, key, ...(parts.description === undefined ? {} : { description: parts.description }),
  labels: { name }, execution: "interactive", runAs: { kind: "initiator" }, inputs: parts.inputs, variables: {}, triggers: [],
  tasks: parts.tasks, outputs: parts.outputs, errors: [], finally: [],
});

const created = (candidate: ApplicationSourceDocument, flow: SourceFlow, moduleKey: string | null,
  binding: Readonly<{ id: string; eventId: string }> | undefined): StudioFlowCreateResult => {
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { kind: "refused", reason: first === undefined ? "The draft is not valid with this flow."
      : `The new flow is not valid: ${first.message} (${first.path.map(String).join(", ")}).` };
  }
  const issue = validateFlow(flow)[0];
  if (issue !== undefined) return { kind: "refused", reason: `${describeStudioFlowLocation(flow, issue.path)}: ${issue.message}.` };
  return { kind: "applied", source: parsed.data, selection: { kind: "flow", flowAlias: flow.id, moduleKey },
    ...(binding === undefined ? {} : { binding }) };
};

export const applyStudioFlowCreate = (
  source: Readonly<ApplicationSourceDocument>,
  command: StudioFlowCreateCommand,
): StudioFlowCreateResult => {
  try {
    const candidate: ApplicationSourceDocument = structuredClone(source);
    const body = candidate.body;
    if (command.kind === "bind") {
      const flow = body.flows.find((entry) => entry.key === command.flowKey);
      if (flow === undefined) return { kind: "refused", reason: "That flow is no longer in the draft." };
      return created(candidate, flow, null, bindControl(body, command.controlAlias, command.event, flow.key, command.bindingInputs));
    }
    const name = command.name.trim();
    if (name.length < 1 || name.length > 100) return { kind: "refused", reason: "Name the flow, in at most 100 characters." };
    if (command.kind === "before_save") {
      const module = body.modules.find((entry) => entry.key === command.moduleKey);
      if (module === undefined) return { kind: "refused", reason: "This application does not own that module, so it cannot hold a flow for it." };
      if (!module.record_types.some((recordType) => recordType.key === command.recordTypeKey))
        return { kind: "refused", reason: "That record type is not in the module." };
      if (command.operations.length === 0) return { kind: "refused", reason: "Choose when the flow runs: when a record is created, changed, or both." };
      const key = keyFrom(name, new Set(module.flows.flatMap((entry) => [entry.id, entry.key])));
      if (key === undefined) return { kind: "refused", reason: "No free name could be made for this flow. Choose another name." };
      const flow: SourceFlow = { contractVersion: flowContractVersion, id: key, key, labels: { name }, execution: "transaction",
        runAs: { kind: "saver" }, inputs: {}, variables: {}, outputs: {}, errors: [], finally: [],
        triggers: [{ id: "before_save", type: "BeforeSave", recordTypeId: command.recordTypeKey, inputs: {},
          operations: command.operations.map((kind) => ({ kind })), priority: 100 }],
        tasks: [{ id: "warn", type: "rule.warn", version: "1.0.0", properties: { message: message("Edit this message") } }] };
      module.flows.push(flow);
      return created(candidate, flow, module.key, undefined);
    }
    const key = keyFrom(name, new Set(body.flows.flatMap((entry) => [entry.id, entry.key])));
    if (key === undefined) return { kind: "refused", reason: "No free name could be made for this flow. Choose another name." };
    const flow = command.kind === "action"
      ? interactiveFlow(key, name, { inputs: {}, outputs: {},
        tasks: [{ id: "show_message", type: "interface.show_message", version: "1.0.0", properties: { message: message("Edit this message") } }] })
      : interactiveFlow(key, name, { description: command.description, inputs: command.inputs, tasks: command.tasks, outputs: command.outputs });
    const binding = command.kind === "action"
      ? bindControl(body, command.controlAlias, "action", key, {})
      : bindControl(body, command.controlAlias, command.event, key, command.bindingInputs);
    body.flows.push(flow);
    return created(candidate, flow, null, binding);
  } catch (error) {
    if (error instanceof FlowCreateRefusal) return { kind: "refused", reason: error.message };
    throw error;
  }
};
