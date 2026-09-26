import { flowTaskChildLists, type FlowDefinition, type FlowTask } from "@vortex/contracts";

/**
 * A form page declares no commit of its own: it commits what the flows bound to its controls'
 * `form_submit` events commit. This is the one derivation of that commit, shared by Definition
 * validation, which refuses a form that commits nothing or anything outside its record type, and
 * by the compiler's agent tool bundle, so the two can never drift.
 */

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

/** How the executable actions a flow can commit are named in this Application's release. */
export type FormCommitActions = Readonly<{
  /** A bound Module's standard record action key by `${recordTypeId}:${standardAction}`. */
  standardActionKeysByRecordAction: ReadonlyMap<string, string>;
  /** Every executable action key: Application and bound Module named actions and standard actions. */
  executableActionKeys: ReadonlySet<string>;
}>;

/** The canonical Application content the derivation reads. */
export type FormCommitContent = Readonly<{
  pages: readonly unknown[];
  shells: readonly unknown[];
  flows: readonly unknown[];
  flowBindings: readonly unknown[];
}>;

/**
 * The executable action keys a flow commits: a Save record task commits the standard create or
 * update of its record type, and a Call protected operation task commits the executable action it
 * calls. A Run flow task commits whatever the flow it runs commits, followed once per flow. A Save
 * that resolves to no bound standard action, or a Run flow of a flow outside this release, commits
 * an empty key, so it can never satisfy a form's record type.
 */
function flowCommitActionKeys(
  flow: FlowDefinition,
  flowsById: ReadonlyMap<string, FlowDefinition>,
  actions: FormCommitActions,
): string[] {
  const keys: string[] = [];
  const followed = new Set<string>();
  const visit = (tasks: readonly FlowTask[]): void => {
    for (const task of tasks) {
      if (task.type === "run_flow") {
        const target = flowsById.get(
          String((task as Extract<FlowTask, { type: "run_flow" }>).flowId),
        );
        if (target === undefined) keys.push("");
        else visitFlow(target);
      }
      const properties = (task as { properties?: Record<string, JsonObject> }).properties;
      const literal = (name: string): string | undefined => {
        const value = properties?.[name];
        return value?.kind === "literal" ? String(object(value.literal).value) : undefined;
      };
      if (task.type === "record.save")
        keys.push(
          actions.standardActionKeysByRecordAction.get(
            `${literal("record_type")}:${properties?.record === undefined ? "create" : "update"}`,
          ) ?? "",
        );
      else if (task.type === "operation.call") {
        const called = literal("operation");
        if (called !== undefined && actions.executableActionKeys.has(called)) keys.push(called);
      }
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  const visitFlow = (candidate: FlowDefinition): void => {
    if (followed.has(String(candidate.id))) return;
    followed.add(String(candidate.id));
    visit(candidate.tasks);
    visit(candidate.errors);
    visit(candidate.finally);
  };
  visitFlow(flow);
  return keys;
}

/** Every placement id in a slot, including placements nested in child slots. */
function slotPlacementIds(slotValue: unknown, ids: string[] = []): string[] {
  for (const [placementId, placementValue] of Object.entries(object(object(slotValue).placements))) {
    ids.push(placementId);
    for (const childSlot of Object.values(object(object(placementValue).slots)))
      slotPlacementIds(childSlot, ids);
  }
  return ids;
}

/** The placement ids a page shows: its own content and, in an Application shell, the shell's. */
function pagePlacementIds(page: JsonObject, shellsById: ReadonlyMap<string, JsonObject>): string[] {
  const composition = object(page.composition);
  const ids: string[] = [];
  if ("main" in composition) slotPlacementIds(composition.main, ids);
  else if ("content" in composition)
    for (const slot of Object.values(object(composition.content))) slotPlacementIds(slot, ids);
  else if (composition.shellKind === "default")
    for (const slot of Object.values(object(composition.stepContent))) slotPlacementIds(slot, ids);
  else
    for (const step of Object.values(object(composition.stepContent)))
      for (const slot of Object.values(object(step))) slotPlacementIds(slot, ids);
  if (composition.shellKind === "application")
    slotPlacementIds(shellsById.get(String(composition.shellId))?.layout, ids);
  return ids;
}

/**
 * Each form and guided-form page's derived commit, by page id: the distinct keys its bound
 * `form_submit` flows commit, in first-seen order. An empty key marks a commit that resolves to no
 * executable action. A guided form commits across all its steps, so a step that only advances the
 * form commits nothing and the step that saves supplies the commit.
 */
export function deriveFormCommitActionKeys(
  content: FormCommitContent,
  actions: FormCommitActions,
): Map<string, string[]> {
  const flowsById = new Map(
    content.flows.map((flow) => [String(object(flow).id), flow as FlowDefinition] as const),
  );
  const shellsById = new Map(
    content.shells.map((shell) => [String(object(shell).shellId), object(shell)] as const),
  );
  const keysByControl = new Map<string, string[]>();
  for (const bindingValue of content.flowBindings) {
    const binding = object(bindingValue);
    if (binding.event !== "form_submit") continue;
    const flow = flowsById.get(String(object(binding.flow).flowId));
    if (flow === undefined) continue;
    const controlId = String(binding.controlId);
    keysByControl.set(controlId, [
      ...(keysByControl.get(controlId) ?? []),
      ...flowCommitActionKeys(flow, flowsById, actions),
    ]);
  }
  const commits = new Map<string, string[]>();
  for (const pageValue of content.pages) {
    const page = object(pageValue);
    if (page.type !== "form" && page.type !== "guided_form") continue;
    const keys = new Set<string>();
    for (const placementId of pagePlacementIds(page, shellsById))
      for (const key of keysByControl.get(placementId) ?? []) keys.add(key);
    commits.set(String(page.pageId), [...keys]);
  }
  return commits;
}
