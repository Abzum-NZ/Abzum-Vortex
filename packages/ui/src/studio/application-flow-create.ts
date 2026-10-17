import {
  applicationSourceDocumentSchema,
  builderKeySchema,
  flowContractVersion,
  validateFlow,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceFlow,
} from "@vortex/platform/schema";
import { describeStudioFlowLocation, studioWords } from "./application-flow-model";
import { traverseStudioSemanticSelectionDraft, type StudioSemanticSelection } from "./semantic-selection";

/**
 * Creating a flow with the minimum valid shape, bound the one way flows are bound:
 * - for an action control: an interactive flow started by the person, with one Show message step,
 *   and one flow binding of the control's action event to it (the existing `flow_bindings` model);
 *   on a record page the flow reads the record the page shows as its `record_id` input;
 * - for a record event: a transaction flow an owned Module runs before one of its record types is
 *   saved, with one Warn step (the trigger is the flow's own `triggers`, as Module rules have).
 */

export type StudioFlowCreateCommand =
  /** On a record page, the flow gets the record the page shows as its record_id input. */
  | Readonly<{ kind: "action"; controlAlias: string; name: string; recordType: string | null }>
  | Readonly<{ kind: "before_save"; moduleKey: string; recordTypeKey: string; name: string;
      operations: readonly ("create" | "update")[] }>;

export type StudioFlowCreateResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument; selection: Extract<StudioSemanticSelection, { kind: "flow" }> }>
  | Readonly<{ kind: "refused"; reason: string }>;

export type StudioFlowCreateChoices = Readonly<{
  /**
   * Action controls (buttons that are not a form's Save or Continue, which submit their form to
   * its own flow) with no flow bound yet; on a record page, the record type the page shows.
   */
  actions: readonly Readonly<{ controlAlias: string; label: string; recordType: string | null }>[];
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
  const actions: { controlAlias: string; label: string; recordType: string | null }[] = [];
  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase !== "enter" || node.kind !== "placement" || bound.has(node.selection.placementAlias)) return;
    const release = draft.catalogue.releases.find((candidate) => String(candidate.blockId) === node.block.block_id &&
      String(candidate.releaseVersion) === node.block.release_version);
    if (release?.supportedEvents.includes("action") !== true || node.settings.action_kind === "submit") return;
    const owner = node.owner;
    const page = owner.kind === "page" ? draft.source.body.pages.find((candidate) => candidate.id === owner.pageAlias) : undefined;
    const recordType = page?.type === "detail" && "record_type" in page && typeof page.record_type === "string" ? page.record_type : null;
    actions.push({ controlAlias: node.selection.placementAlias, label: controlLabel(node.selection.placementAlias), recordType });
  });
  const recordTypes = draft.source.body.modules.flatMap((module) => module.record_types.map((recordType) => ({
    moduleKey: module.key, moduleName: module.name, recordTypeKey: recordType.key,
    label: "name" in recordType && typeof recordType.name === "string" ? recordType.name : studioWords(recordType.key),
  })));
  return { actions, recordTypes };
};

/** A builder key from a name, unique among the taken ones. */
const keyFrom = (name: string, taken: ReadonlySet<string>): string | undefined => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 34) || "flow";
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate) && builderKeySchema.safeParse(candidate).success) return candidate;
  }
  return undefined;
};

const message = (value: string) => ({ kind: "literal" as const, literal: { type: "text" as const, value } });

export const applyStudioFlowCreate = (
  source: Readonly<ApplicationSourceDocument>,
  command: StudioFlowCreateCommand,
): StudioFlowCreateResult => {
  const name = command.name.trim();
  if (name.length < 1 || name.length > 100) return { kind: "refused", reason: "Name the flow, in at most 100 characters." };
  const candidate: ApplicationSourceDocument = structuredClone(source);
  const body = candidate.body;
  let flows: SourceFlow[];
  let moduleKey: string | null;
  let flow: SourceFlow;
  if (command.kind === "action") {
    if (body.flow_bindings.some((binding) => binding.control === command.controlAlias && binding.event === "action"))
      return { kind: "refused", reason: "This control already runs a flow when it is used. Open that flow and change it instead." };
    flows = body.flows;
    moduleKey = null;
    const key = keyFrom(name, new Set(flows.flatMap((entry) => [entry.id, entry.key])));
    if (key === undefined) return { kind: "refused", reason: "No free name could be made for this flow. Choose another name." };
    flow = { contractVersion: flowContractVersion, id: key, key, labels: { name }, execution: "interactive",
      runAs: { kind: "initiator" },
      inputs: command.recordType === null ? {}
        : { record_id: { type: "record_reference", required: true, recordTypeIds: [command.recordType] } },
      variables: {}, triggers: [], outputs: {}, errors: [], finally: [],
      tasks: [{ id: "show_message", type: "interface.show_message", version: "1.0.0",
        properties: { message: message("Edit this message") } }] };
    const aliases = new Set(body.flow_bindings.flatMap((binding) => [binding.id, binding.event_id]));
    const bindingId = keyFrom(`binding_${key}`, aliases);
    const eventId = keyFrom(`event_${key}`, aliases);
    if (bindingId === undefined || eventId === undefined)
      return { kind: "refused", reason: "No free name could be made for the binding. Choose another name." };
    body.flow_bindings.push({ id: bindingId, control: command.controlAlias, event_id: eventId, event: "action", flow: key,
      inputs: command.recordType === null ? {} : { record_id: { kind: "caller", name: "record_id" } } });
  } else {
    const module = body.modules.find((entry) => entry.key === command.moduleKey);
    if (module === undefined) return { kind: "refused", reason: "This application does not own that module, so it cannot hold a flow for it." };
    if (!module.record_types.some((recordType) => recordType.key === command.recordTypeKey))
      return { kind: "refused", reason: "That record type is not in the module." };
    if (command.operations.length === 0) return { kind: "refused", reason: "Choose when the flow runs: when a record is created, changed, or both." };
    flows = module.flows;
    moduleKey = module.key;
    const key = keyFrom(name, new Set(flows.flatMap((entry) => [entry.id, entry.key])));
    if (key === undefined) return { kind: "refused", reason: "No free name could be made for this flow. Choose another name." };
    flow = { contractVersion: flowContractVersion, id: key, key, labels: { name }, execution: "transaction",
      runAs: { kind: "saver" }, inputs: {}, variables: {}, outputs: {}, errors: [], finally: [],
      triggers: [{ id: "before_save", type: "BeforeSave", recordTypeId: command.recordTypeKey, inputs: {},
        operations: command.operations.map((kind) => ({ kind })), priority: 100 }],
      tasks: [{ id: "warn", type: "rule.warn", version: "1.0.0", properties: { message: message("Edit this message") } }] };
  }
  flows.push(flow);
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { kind: "refused", reason: first === undefined ? "The draft is not valid with this flow."
      : `The new flow is not valid: ${first.message} (${first.path.map(String).join(", ")}).` };
  }
  const issue = validateFlow(flow)[0];
  if (issue !== undefined) return { kind: "refused", reason: `${describeStudioFlowLocation(flow, issue.path)}: ${issue.message}.` };
  return { kind: "applied", source: candidate, selection: { kind: "flow", flowAlias: flow.id, moduleKey } };
};
