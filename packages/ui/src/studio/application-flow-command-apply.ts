import {
  builderKeySchema,
  flowMaximumTaskCount,
  flowTaskChildLists,
  validateFlow,
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";
import {
  sameStudioFlowContext,
  samePath,
  studioFlowKeyFrom,
  studioFlowListAt,
  studioFlowOutline,
  studioFlowValidationOptions,
  studioWithoutUnusedFlows,
  validatedStudioFlowEdit,
  type StudioFlowContext,
  type StudioFlowEditResult,
  type StudioFlowPath,
  type StudioFlowSelection,
  type StudioFlowTaskListOutline,
} from "./application-flow-model";
import { addStudioBackgroundFlow } from "./application-flow-background";
import { applyStudioFlowStepDraft } from "./application-flow-step-form";
import { addStudioFlowShownForm } from "./application-flow-shown-form";
import { studioFlowCallerNames } from "./application-flow-start";
import { studioFlowLabel } from "./semantic-selection";
import {
  newStep,
  noChangeGuard,
  flowRecordInput,
  flowRecordType,
  hasRetainedTaskReference,
  staleEdit,
  studioNewBackendFlowChoice,
  studioNewFormChoice,
  type StudioFlowCommand,
  type StudioFlowNewStepSettings,
} from "./application-flow-commands";

/**
 * Applying one flow command: the commands that change a step, its settings, its place or its
 * bindings, and the combine of two flows. The step builder's defaults and the step-type
 * projection stay in their own modules; nothing here decides what a step type is.
 */

const commandTask = (
  lists: readonly StudioFlowTaskListOutline[],
  id: string,
  path: StudioFlowPath,
): string | undefined => {
  for (const list of lists)
    for (const task of list.tasks) {
      if (task.id === id && samePath(task.path, path)) return task.title;
      const child = commandTask(task.children, id, path);
      if (child !== undefined) return child;
    }
  return undefined;
};

/** Applies one flow command to a detached copy of the current draft and checks the result. */
export const applyStudioFlowCommand = (
  current: StudioFlowContext,
  expected: StudioFlowContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: StudioFlowSelection,
  command: StudioFlowCommand,
): StudioFlowEditResult => {
  if (!sameStudioFlowContext(current, expected, selection, expectedSelection)) return staleEdit();
  try {
    const original = studioFlowOutline(current, expectedSelection);
    const used = new Set(original.entries.map((entry) => entry.task.id));
    const candidate: ApplicationSourceDocument = structuredClone(current.source);
    const detached = studioFlowOutline({ ...current, source: candidate }, expectedSelection).flow;
    const done = (taskId: string) =>
      validatedStudioFlowEdit(candidate, current.source, expectedSelection, taskId, current);
    const full =
      original.entries.length >= flowMaximumTaskCount
        ? {
            kind: "invalid" as const,
            reason: `A flow can hold at most ${flowMaximumTaskCount} steps, nested steps included.`,
          }
        : undefined;

    /** A Show form step that asks for a new form gets it on the page of the flow's button first. */
    const stepInputs = (
      taskType: string,
      settings: StudioFlowNewStepSettings,
    ):
      | { source: Readonly<ApplicationSourceDocument>; settings: StudioFlowNewStepSettings }
      | { refused: StudioFlowEditResult } => {
      let source: Readonly<ApplicationSourceDocument> = current.source;
      if (settings.firstStep !== undefined) {
        const inner = stepInputs(settings.firstStep.type, settings.firstStep.settings);
        if ("refused" in inner) return inner;
        source = inner.source;
        settings = { ...settings, firstStep: { ...settings.firstStep, settings: inner.settings } };
      }
      if (taskType === "backend.run" && settings.choices?.flow === studioNewBackendFlowChoice) {
        const recordType = flowRecordType(original.flow);
        if (recordType === undefined)
          return {
            refused: {
              kind: "invalid",
              reason: "This flow runs for no record, so a back-end flow cannot be made for it.",
            } as const,
          };
        const moduleKey =
          candidate.body.modules.find((entry) =>
            entry.flows.some((flow) => flow.id === original.flow.id),
          )?.key ?? null;
        const made = addStudioBackgroundFlow(
          candidate.body,
          {
            kind: "background",
            moduleKey,
            recordTypeKey: recordType,
            name: `${studioFlowLabel(original.flow)} back-end flow`,
            event: null,
          },
          `${studioFlowLabel(original.flow)} back-end flow`,
        );
        if (typeof made === "string")
          return { refused: { kind: "invalid", reason: made } as const };
        return {
          source: candidate as Readonly<ApplicationSourceDocument>,
          settings: { ...settings, choices: { ...settings.choices, flow: made.flow.id } },
        };
      }
      if (taskType !== "interface.show_form" || settings.choices?.form !== studioNewFormChoice)
        return { source, settings };
      const added = addStudioFlowShownForm(
        current.catalogue,
        candidate,
        original.flow,
        studioFlowLabel(original.flow),
      );
      if (!added.ok) return { refused: { kind: "invalid", reason: added.reason } as const };
      return {
        source: candidate as Readonly<ApplicationSourceDocument>,
        settings: { ...settings, choices: { ...settings.choices, form: added.alias } },
      };
    };

    if (command.kind === "insert_task") {
      const target = studioFlowListAt(detached, command.listPath);
      if (
        target === undefined ||
        !Number.isInteger(command.index) ||
        command.index < 0 ||
        command.index > target.length
      )
        return staleEdit("That place in the flow changed. Select a step again and retry.");
      if (full !== undefined) return full;
      const inputs = stepInputs(command.taskType, command.settings);
      if ("refused" in inputs) return inputs.refused;
      const task = newStep(
        original.flow,
        inputs.source,
        command.taskType,
        used,
        current,
        inputs.settings,
      );
      if ("kind" in task && !("id" in task)) return task;
      // Saving the changes of a form's record starts by saying so when nothing changed.
      const guard =
        command.taskType === "record.save" &&
        original.flow.inputs?.values?.type === "json" &&
        flowRecordInput(original.flow) !== undefined
          ? noChangeGuard(original.flow, inputs.source, current, used)
          : [];
      target.splice(command.index, 0, ...guard, task as SourceFlowTask);
      return done((task as SourceFlowTask).id);
    }

    if (
      !builderKeySchema.safeParse(command.taskId).success ||
      commandTask(original.lists, command.taskId, command.taskPath) === undefined
    )
      return staleEdit("That step is no longer in the draft. Select it again.");
    const index = command.taskPath[command.taskPath.length - 1];
    const parentPath = command.taskPath.slice(0, -1);
    const list = studioFlowListAt(detached, parentPath);
    if (typeof index !== "number" || list?.[index]?.id !== command.taskId) return staleEdit();

    switch (command.kind) {
      case "remove_task": {
        if (list.length === 1 && parentPath[0] !== "errors" && parentPath[0] !== "finally")
          return {
            kind: "unsupported",
            reason:
              parentPath.length === 1
                ? "A flow keeps at least one step. Add another step first, then remove this one."
                : "A branch keeps at least one step. Remove the step that owns the branch instead.",
          };
        const removed = original.entries
          .filter(
            ({ path }) =>
              path.length >= command.taskPath.length &&
              samePath(path.slice(0, command.taskPath.length), command.taskPath),
          )
          .map(({ task }) => task.id);
        list.splice(index, 1);
        const referenced = removed.find((id) => hasRetainedTaskReference(detached, id));
        if (referenced !== undefined)
          return {
            kind: "unsupported",
            reason:
              "Another step or part of the application still reads the result of this step. Change that first.",
          };
        return done(command.taskId);
      }
      case "move_task": {
        const to = index + (command.direction === "up" ? -1 : 1);
        if (to < 0 || to >= list.length)
          return {
            kind: "invalid",
            reason:
              command.direction === "up"
                ? "This step is already first in its list."
                : "This step is already last in its list.",
          };
        const [moved] = list.splice(index, 1);
        list.splice(to, 0, moved!);
        return done(command.taskId);
      }
      case "add_branch": {
        if (full !== undefined) return full;
        const inputs = stepInputs(command.taskType, command.settings);
        if ("refused" in inputs) return inputs.refused;
        const task = newStep(
          original.flow,
          inputs.source,
          command.taskType,
          used,
          current,
          inputs.settings,
        );
        if ("kind" in task && !("id" in task)) return task;
        const owner = list[index]!;
        if (owner.type === "if" && "then" in owner && owner.else === undefined)
          owner.else = [task as SourceFlowTask];
        else if (owner.type === "switch" && "cases" in owner && owner.default === undefined)
          owner.default = [task as SourceFlowTask];
        else
          return {
            kind: "unsupported",
            reason:
              "This step has no branch to add. Only a decision without Else or Otherwise can get one.",
          };
        return done((task as SourceFlowTask).id);
      }
      case "set_step": {
        const built = applyStudioFlowStepDraft(
          current.source,
          original.flow,
          expectedSelection.moduleKey,
          list[index]!,
          command.taskPath,
          command.draft,
        );
        if (!built.ok) return { kind: "invalid", reason: built.reason };
        // Settings that come out as the step already has them apply as no change.
        list[index] = built.value;
        const checked = done(command.taskId);
        // A well-formed formula belongs in the draft even when its type or references will
        // prevent publication. Other new validation issues still refuse the edit.
        if (
          checked.kind === "invalid" &&
          Array.isArray(checked.cause) &&
          checked.cause.length > 0 &&
          checked.cause.every((issue) => {
            if (issue.taskId !== command.taskId || !Array.isArray(issue.path)) return false;
            const property = issue.path.lastIndexOf("properties");
            return property >= 0 && issue.path[property + 1] === "formula";
          })
        )
          return { kind: "applied", source: candidate, taskId: command.taskId };
        return checked;
      }
    }
  } catch (cause) {
    return { kind: "invalid", cause, reason: "The draft could not be read to make this change." };
  }
};

// ─── Combining two flows on one event ────────────────────────────────────────────────────────

export type StudioFlowCombineResult =
  | Readonly<{
      kind: "applied";
      source: ApplicationSourceDocument;
      /** The new flow the event runs, and the two flows it replaced (removed when nothing else uses them). */
      flowKey: string;
      replaced: readonly [string, string];
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Step types after which a flow does not carry on: a second flow's steps would never run. */
const endingStepTypes: ReadonlySet<string> = new Set(["stop", "interface.navigate", "rule.refuse"]);

type FlowTaskList = readonly SourceFlowTask[];
const childTaskLists = (task: SourceFlowTask): FlowTaskList[] =>
  flowTaskChildLists(task as never).map((child) => child.tasks as unknown as FlowTaskList);

const flowTaskIds = (tasks: FlowTaskList, ids: string[] = []): string[] => {
  for (const task of tasks) {
    ids.push(task.id);
    for (const children of childTaskLists(task)) flowTaskIds(children, ids);
  }
  return ids;
};

const endsEarly = (tasks: FlowTaskList): boolean =>
  tasks.some(
    (task) =>
      endingStepTypes.has(task.type) || childTaskLists(task).some((list) => endsEarly(list)),
  );

/** The value with every reference to a renamed step pointing at its new id. */
const renameStepReferences = (value: unknown, renames: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string")
    return value.replace(/{{\s*outputs\.([a-z][a-z0-9_]*)\./g, (whole, task: string) => {
      const next = renames.get(task);
      return next === undefined ? whole : `{{ outputs.${next}.`;
    });
  if (Array.isArray(value)) return value.map((item) => renameStepReferences(item, renames));
  if (value === null || typeof value !== "object") return value;
  const entry = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(entry).map(([key, child]) => {
      const renamed =
        typeof child === "string" &&
        renames.has(child) &&
        (key === "id" || (key === "task" && entry.source === "task_output"));
      return [key, renamed ? renames.get(child as string) : renameStepReferences(child, renames)];
    }),
  );
};

/**
 * One event runs one flow, so two flows wanted on one event become one new flow: the first flow's
 * steps, then the second's. The second flow's step ids are made unique and its references to its
 * own steps follow. Inputs, variables and outputs are merged; two different declarations of one
 * name are refused with a sentence. The event now runs the new flow; the two old flows stay in the
 * draft for the caller to remove when nothing else uses them. It is one edit of the draft.
 */
export const applyStudioFlowCombine = (
  source: ApplicationSourceDocument,
  bindingId: string,
  otherFlowKey: string,
): StudioFlowCombineResult => {
  const refuse = (reason: string): StudioFlowCombineResult => ({ kind: "refused", reason });
  const candidate = structuredClone(source);
  const body = candidate.body;
  const binding = body.flow_bindings.find((entry) => entry.id === bindingId);
  const first = body.flows.find((flow) => flow.id === binding?.flow || flow.key === binding?.flow);
  const second = body.flows.find((flow) => flow.key === otherFlowKey);
  if (binding === undefined || first === undefined || second === undefined)
    return refuse("That event or flow is no longer in the draft. Reload the draft.");
  if (first.id === second.id) return refuse("Choose a different flow to combine with.");
  if (second.execution !== "interactive" || second.triggers.length > 0)
    return refuse(
      `${studioFlowLabel(second)} also starts from a record event, so it cannot be combined.`,
    );
  if (endsEarly(first.tasks))
    return refuse(
      `${studioFlowLabel(first)} can end before the second flow's steps run (it navigates, stops or refuses). Remove that step first.`,
    );
  if (JSON.stringify(first.runAs) !== JSON.stringify(second.runAs))
    return refuse("The two flows run as different people, so they cannot be combined.");
  const merge = <Value>(
    what: string,
    a: Readonly<Record<string, Value>>,
    b: Readonly<Record<string, Value>>,
  ): Record<string, Value> | string => {
    const merged: Record<string, Value> = { ...a };
    for (const [name, declared] of Object.entries(b)) {
      if (name in merged && JSON.stringify(merged[name]) !== JSON.stringify(declared))
        return `Both flows declare the ${what} "${name}" differently. Rename one of them first.`;
      merged[name] = declared;
    }
    return merged;
  };
  const inputs = merge("input", first.inputs, second.inputs);
  if (typeof inputs === "string") return refuse(inputs);
  const variables = merge("variable", first.variables, second.variables);
  if (typeof variables === "string") return refuse(variables);
  const clashing = Object.keys(second.outputs).find((name) => name in first.outputs);
  if (clashing !== undefined)
    return refuse(`Both flows return "${clashing}". Rename one of them first.`);
  if (
    first.recordInput !== undefined &&
    second.recordInput !== undefined &&
    first.recordInput !== second.recordInput
  )
    return refuse("The two flows run for different record inputs, so they cannot be combined.");
  const lists = (flow: SourceFlow): FlowTaskList[] => [flow.tasks, flow.errors, flow.finally];
  const taken = new Set(lists(first).flatMap((list) => flowTaskIds(list)));
  const renames = new Map<string, string>();
  for (const id of lists(second).flatMap((list) => flowTaskIds(list))) {
    if (!taken.has(id)) {
      taken.add(id);
      continue;
    }
    const next = studioFlowKeyFrom(`${id}_2`, taken);
    if (next === undefined) return refuse("No free step name could be made. Rename a step first.");
    taken.add(next);
    renames.set(id, next);
  }
  const moved = <Value>(value: Value): Value => renameStepReferences(value, renames) as Value;
  const wantedName = `${studioFlowLabel(first)} and ${studioFlowLabel(second)}`.slice(0, 94);
  const names = new Set(
    [...body.flows, ...body.modules.flatMap((module) => module.flows)].map((flow) =>
      (flow.labels?.name ?? flow.key).toLowerCase(),
    ),
  );
  let name = wantedName;
  for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${wantedName} ${n}`;
  const key = studioFlowKeyFrom(name, new Set(body.flows.flatMap((flow) => [flow.id, flow.key])));
  if (key === undefined) return refuse("No free name could be made for the combined flow.");
  const supplied = new Set(studioFlowCallerNames(binding.event).map((entry) => entry.name));
  const bindingInputs: typeof binding.inputs = { ...binding.inputs };
  for (const [inputName, declared] of Object.entries(second.inputs)) {
    if (inputName in bindingInputs) continue;
    if (supplied.has(inputName)) bindingInputs[inputName] = { kind: "caller", name: inputName };
    else if (declared.required)
      return refuse(
        `${studioFlowLabel(second)} needs "${inputName}", which this event does not supply.`,
      );
  }
  const recordInput = first.recordInput ?? second.recordInput;
  const combined: SourceFlow = {
    id: key,
    key,
    description: `${studioFlowLabel(first)}, then ${studioFlowLabel(second)}.`,
    labels: { name },
    execution: "interactive",
    runAs: first.runAs,
    inputs,
    ...(recordInput === undefined ? {} : { recordInput }),
    variables,
    triggers: [],
    tasks: [...first.tasks, ...moved(second.tasks)],
    outputs: { ...first.outputs, ...moved(second.outputs) },
    errors: [...first.errors, ...moved(second.errors)],
    finally: [...first.finally, ...moved(second.finally)],
  };
  body.flows.push(combined);
  binding.flow = key;
  binding.inputs = bindingInputs;
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse(
      issue === undefined
        ? "The combined flow is not valid."
        : `The combined flow is not valid: ${issue.message} (${issue.path.map(String).join(", ")}).`,
    );
  }
  const problem = validateFlow(
    combined,
    studioFlowValidationOptions(parsed.data, combined, [
      ...parsed.data.body.flows,
      ...parsed.data.body.modules.flatMap((module) => module.flows),
    ]),
  )[0];
  if (problem !== undefined) return refuse(`The combined flow is not valid: ${problem.message}.`);
  return {
    kind: "applied",
    source: studioWithoutUnusedFlows(parsed.data, [first.key, second.key]),
    flowKey: key,
    replaced: [first.key, second.key],
  };
};
