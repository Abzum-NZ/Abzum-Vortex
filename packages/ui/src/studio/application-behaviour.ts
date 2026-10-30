import {
  applicationSourceDocumentSchema,
  pageSemanticEventKinds,
  recordLoadedPageTypes,
  sourceItemTree,
  sourcePageItems,
  type ApplicationSourceDocument,
  type ComponentSemanticEventKind,
  type FlowBindingSettings,
  type ImmutablePlatformBlockCatalogue,
  type SourceFlow,
} from "@vortex/platform/schema";
import { studioFlowCallerNames } from "./application-flow-start";
import {
  applyStudioFlowCreate,
  studioFlowCreateSavesChange,
  type StudioFlowCreateCommand,
} from "./application-flow-create";
import type { StudioBorrowedChoices } from "./contextual-palette";
import { studioEventWords, studioWithoutUnusedFlows } from "./application-flow-model";
import { studioFlowLabel } from "./semantic-selection";

/**
 * The Behaviour panel's model: every event the selected component (or the page) raises, with the
 * flow it runs. The events of a component are the ones its block release declares in the catalogue;
 * the events of a page are the page events of the platform contract. No list of events lives in
 * Studio.
 */

type SourceBinding = ApplicationSourceDocument["body"]["flow_bindings"][number];

export type StudioBehaviourTarget =
  | Readonly<{ kind: "placement"; placementAlias: string }>
  | Readonly<{ kind: "page"; pageAlias: string }>;

export type StudioBehaviourBinding = Readonly<{
  id: string;
  /** The key of the flow the event runs. */
  flowKey: string;
  flowName: string;
  settings: FlowBindingSettings;
}>;

export type StudioBehaviourEvent = Readonly<{
  event: ComponentSemanticEventKind;
  /** "When it is used", "When the page loads". */
  label: string;
  /** The flow the event runs; null while no flow is bound. */
  binding: StudioBehaviourBinding | null;
}>;

/** The control a binding of this target is written against: the placement's alias or the page's. */
export const studioBehaviourControl = (target: StudioBehaviourTarget): string =>
  target.kind === "placement" ? target.placementAlias : target.pageAlias;

const eventLabel = (target: StudioBehaviourTarget, event: string): string =>
  `When ${target.kind === "page" ? "the page" : "it"} ${studioEventWords[event] ?? "is used"}`;

const flowOf = (source: ApplicationSourceDocument, reference: string): SourceFlow | undefined =>
  source.body.flows.find((flow) => flow.id === reference || flow.key === reference);

/**
 * The events the target raises. A row action menu keeps its own list (several entries per
 * component), so `row_action` is left to it.
 */
export const projectStudioBehaviour = (
  draft: Readonly<{
    source: ApplicationSourceDocument;
    catalogue: ImmutablePlatformBlockCatalogue;
  }>,
  target: StudioBehaviourTarget,
): readonly StudioBehaviourEvent[] => {
  const { source, catalogue } = draft;
  const events = (): readonly ComponentSemanticEventKind[] => {
    if (target.kind === "page") {
      const page = source.body.pages.find((candidate) => candidate.id === target.pageAlias);
      return page === undefined
        ? []
        : pageSemanticEventKinds.filter(
            (event) => event !== "record_loaded" || recordLoadedPageTypes.has(page.type),
          );
    }
    const item = [
      ...source.body.pages.flatMap((page) => sourcePageItems(page.composition)),
      ...source.body.shells.flatMap((shell) => sourceItemTree(shell.layout.content)),
    ].find((entry) => entry.props.id === target.placementAlias);
    const block = item?.props.vortex.block;
    const release = catalogue.releases.find(
      (candidate) =>
        String(candidate.blockId) === block?.block_id &&
        String(candidate.releaseVersion) === block?.release_version,
    );
    return (release?.supportedEvents ?? []).filter((event) => event !== "row_action");
  };
  const control = studioBehaviourControl(target);
  return events().map((event): StudioBehaviourEvent => {
    const bound = source.body.flow_bindings.find(
      (binding) => binding.control === control && binding.event === event,
    );
    const flow = bound === undefined ? undefined : flowOf(source, bound.flow);
    return {
      event,
      label: eventLabel(target, event),
      binding:
        bound === undefined
          ? null
          : {
              id: bound.id,
              flowKey: flow?.key ?? bound.flow,
              flowName: flow === undefined ? "A flow that is missing" : studioFlowLabel(flow),
              settings: bound.settings,
            },
    };
  });
};

export type StudioBehaviourResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "refused"; reason: string }>;

const checked = (candidate: ApplicationSourceDocument): StudioBehaviourResult => {
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (parsed.success) return { kind: "applied", source: parsed.data };
  const first = parsed.error.issues[0];
  return {
    kind: "refused",
    reason:
      first === undefined
        ? "The draft is not valid with this change."
        : `${first.message} (${first.path.map(String).join(", ")}).`,
  };
};

const bindingIn = (
  candidate: ApplicationSourceDocument,
  bindingId: string,
): SourceBinding | undefined =>
  candidate.body.flow_bindings.find((binding) => binding.id === bindingId);

/** Writes one binding's run settings: start condition, debounce, concurrency, exclusive scope, timeout. */
export const applyStudioBindingSettings = (
  source: ApplicationSourceDocument,
  bindingId: string,
  settings: FlowBindingSettings,
): StudioBehaviourResult => {
  const candidate = structuredClone(source);
  const binding = bindingIn(candidate, bindingId);
  if (binding === undefined)
    return { kind: "refused", reason: "That event no longer runs a flow. Reload the draft." };
  binding.settings = settings;
  return checked(candidate);
};

/**
 * Makes the event run another flow. What the event supplies by name fills the new flow's inputs of
 * the same name; an input the event cannot supply is refused with its name.
 */
export const applyStudioRebind = (
  source: ApplicationSourceDocument,
  bindingId: string,
  flowKey: string,
): StudioBehaviourResult => {
  const candidate = structuredClone(source);
  const binding = bindingIn(candidate, bindingId);
  const flow = flowOf(candidate, flowKey);
  if (binding === undefined || flow === undefined)
    return { kind: "refused", reason: "That event or flow is no longer in the draft. Reload." };
  if (flow.execution !== "interactive")
    return { kind: "refused", reason: "Only an interactive flow can run when an event happens." };
  const supplied = new Set(studioFlowCallerNames(binding.event).map((entry) => entry.name));
  const inputs: SourceBinding["inputs"] = {};
  for (const [name, declared] of Object.entries(flow.inputs)) {
    const kept = binding.inputs[name];
    if (kept !== undefined) inputs[name] = kept;
    else if (supplied.has(name)) inputs[name] = { kind: "caller", name };
    else if (declared.required)
      return {
        kind: "refused",
        reason: `${studioFlowLabel(flow)} needs "${name}", which this event does not supply.`,
      };
  }
  const replaced = binding.flow;
  binding.flow = flow.key;
  binding.inputs = inputs;
  const result = checked(candidate);
  return result.kind === "applied"
    ? { kind: "applied", source: studioWithoutUnusedFlows(result.source, [replaced]) }
    : result;
};

/** Removes the binding: the event runs no flow any more. */
export const applyStudioUnbind = (
  source: ApplicationSourceDocument,
  bindingId: string,
): StudioBehaviourResult => {
  const candidate = structuredClone(source);
  candidate.body.flow_bindings = candidate.body.flow_bindings.filter(
    (binding) => binding.id !== bindingId,
  );
  return checked(candidate);
};

type CreateCommand = Extract<StudioFlowCreateCommand, { kind: "action" }>;

/** The operation a flow's Call protected operation step runs. */
const operationOf = (flow: SourceFlow): string | undefined => {
  for (const task of flow.tasks) {
    const operation = (task as { properties?: Readonly<Record<string, unknown>> }).properties
      ?.operation as { kind?: string; literal?: { value?: unknown } } | undefined;
    if (
      task.type === "operation.call" &&
      operation?.kind === "literal" &&
      typeof operation.literal?.value === "string"
    )
      return operation.literal.value;
  }
  return undefined;
};

/**
 * The default flow of an event, made the way a new one is made: a board move or a table edit saves
 * the change; a button calls the named action its flow calls today. Other events have no generator,
 * so they cannot be reset.
 */
export const studioBindingDefault = (
  source: ApplicationSourceDocument,
  bindingId: string,
): CreateCommand | undefined => {
  const binding = bindingIn(source, bindingId);
  if (binding === undefined) return undefined;
  const flow = flowOf(source, binding.flow);
  if (flow === undefined) return undefined;
  const recordType =
    source.body.events.find((event) => event.id === binding.event_id)?.record_type ?? null;
  const base = {
    kind: "action",
    controlAlias: binding.control,
    name: studioFlowLabel(flow),
  } as const;
  if (studioFlowCreateSavesChange(binding.event, recordType))
    return { ...base, event: binding.event, recordType };
  const operation = binding.event === "action" ? operationOf(flow) : undefined;
  return operation === undefined
    ? undefined
    : {
        ...base,
        event: binding.event,
        recordType,
        step: { kind: "operation", operation },
      };
};

/**
 * Makes the event run a freshly generated default flow again, and removes the flow it ran when
 * nothing else uses it. One edit of the draft.
 */
export const applyStudioResetToDefault = (
  source: ApplicationSourceDocument,
  bindingId: string,
  borrowed: StudioBorrowedChoices | null,
): StudioBehaviourResult => {
  const command = studioBindingDefault(source, bindingId);
  const binding = bindingIn(source, bindingId);
  if (command === undefined || binding === undefined)
    return { kind: "refused", reason: "This event has no default flow to go back to." };
  const replaced = binding.flow;
  const candidate = structuredClone(source);
  candidate.body.flow_bindings = candidate.body.flow_bindings.filter(
    (entry) => entry.id !== bindingId,
  );
  // The event the old binding declared goes with it when nothing else names it.
  const eventId = binding.event_id;
  const named = JSON.stringify(candidate.body.flows) + JSON.stringify(candidate.body.pages);
  if (
    !candidate.body.flow_bindings.some((entry) => entry.event_id === eventId) &&
    !named.includes(`"${eventId}"`)
  )
    candidate.body.events = candidate.body.events.filter((entry) => entry.id !== eventId);
  const created = applyStudioFlowCreate(candidate, command, borrowed);
  if (created.kind !== "applied") return { kind: "refused", reason: created.reason };
  return { kind: "applied", source: studioWithoutUnusedFlows(created.source, [replaced]) };
};
