import {
  flowTaskChildLists,
  flowTaskRegistry,
  type ApplicationSourceDocument,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import {
  studioWords,
  type StudioCompileFailure,
  type StudioDataSelection,
} from "@vortex/ui/studio";

/** Why the saved draft does not compile, in words, and the Data tab item to change when it is one. */
type StudioCompileProblem = Readonly<{
  message: string;
  selection: StudioDataSelection | null;
}>;

const fieldAdvice: Readonly<Record<string, string>> = {
  calculation:
    "Check its formula and its result: for example, money divided by a number gives money.",
  total: "Check the related records, the field it takes and its result.",
  link: "Check the record type it links to.",
  link_to_one_of_several: "Check the record types it links to.",
  choice: "Check its options.",
  several_choices: "Check its options.",
  table: "Check its columns.",
};

const ruleWords = (reasonCode: string): string =>
  reasonCode.replace(/^vortex\.definition\./u, "").replaceAll("_", " ");

const findFlow = (source: ApplicationSourceDocument, flowKey: string): SourceFlow | undefined =>
  [...source.body.flows, ...source.body.modules.flatMap((module) => module.flows)].find(
    (flow) => flow.key === flowKey,
  );

const findTask = (tasks: readonly SourceFlowTask[], taskId: string): SourceFlowTask | undefined => {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    for (const child of flowTaskChildLists(task as Parameters<typeof flowTaskChildLists>[0])) {
      const found = findTask(child.tasks as readonly SourceFlowTask[], taskId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const operationOf = (source: ApplicationSourceDocument, task: SourceFlowTask) => {
  const key = (task as { properties?: { operation?: { literal?: { value?: unknown } } } })
    .properties?.operation?.literal?.value;
  return source.body.modules
    .flatMap((module) => module.actions)
    .find((candidate) => candidate.key === key);
};

const stepName = (source: ApplicationSourceDocument, task: SourceFlowTask): string => {
  const described = (task as { description?: string }).description;
  if (described !== undefined) return described;
  const operation = task.type === "operation.call" ? operationOf(source, task) : undefined;
  if (operation !== undefined) return `Call ${operation.label}`;
  return (
    flowTaskRegistry[task.type as keyof typeof flowTaskRegistry]?.title ?? ruleWords(task.type)
  );
};

/**
 * A refusal inside a flow, in words: the flow and the step by their names, what is wrong, and how to
 * fix it. The operation a Call step names decides which of the flow's inputs it cannot take.
 */
const describeFlowFailure = (
  failure: StudioCompileFailure,
  source: ApplicationSourceDocument,
): string => {
  const flow = findFlow(source, failure.flowKey ?? "");
  const flowName = flow?.labels?.name ?? ruleWords(failure.flowKey ?? "");
  const task =
    flow === undefined || failure.taskId === undefined
      ? undefined
      : findTask([...flow.tasks, ...flow.errors, ...flow.finally], failure.taskId);
  const where =
    task === undefined ? `Flow ${flowName}` : `Flow ${flowName}, step ${stepName(source, task)}`;
  if (
    failure.reasonCode === "vortex.definition.workflow_action_inputs" &&
    flow !== undefined &&
    task !== undefined
  ) {
    // A platform-service operation is not one of the draft's actions; its inputs are not known here.
    const action = operationOf(source, task);
    if (action === undefined)
      return `${where}: the flow's inputs do not match what the operation takes. Map them in the step's inputs.`;
    const declared = new Set(action.inputs.map((input) => input.key));
    if (failure.family === "unknown_property") {
      const unknown = Object.keys(flow.inputs)
        .filter((name) => !declared.has(name))
        .map(studioWords);
      return `${where}: the operation does not take ${unknown.length === 0 ? "one of the flow's inputs" : unknown.join(", ")}. Map ${unknown.length === 1 ? "it" : "them"} in the step's inputs or remove ${unknown.length === 1 ? "it" : "them"}.`;
    }
    if (failure.family === "required_value") {
      const missing = action.inputs
        .filter((input) => input.required && !Object.hasOwn(flow.inputs, input.key))
        .map((input) => input.label);
      return `${where}: the operation needs ${missing.length === 0 ? "an input the flow does not have" : missing.join(", ")}. Map ${missing.length === 1 ? "it" : "them"} in the step's inputs.`;
    }
  }
  return `${where} can't be used as it is set up (${ruleWords(failure.reasonCode)}). Open the step and check its settings.`;
};

/**
 * The compile refusal of the saved draft as a person reads it: the field or query it is about, by
 * its name, with what to check, or the platform's rule in words when it names neither.
 */
export const describeStudioCompileFailure = (
  failure: StudioCompileFailure,
  source: ApplicationSourceDocument,
): StudioCompileProblem => {
  // A rule with its own business sentence says it as it is, exactly as Studio showed it beforehand.
  if (failure.sentence !== undefined) return { message: failure.sentence, selection: null };
  if (failure.flowKey !== undefined)
    return { message: describeFlowFailure(failure, source), selection: null };
  if (failure.reasonCode === "vortex.definition.application_query_exposure") {
    const reference = failure.queryKey ?? "";
    const separator = reference.indexOf(":");
    const queryName =
      separator < 0 ? "a query" : `the query ${ruleWords(reference.slice(separator + 1))}`;
    return {
      message: `A block reads ${queryName} of another application, which keeps it private. Choose another query for the block, or ask that application's builder to expose it in its Data tab and publish it.`,
      selection: null,
    };
  }
  const modules = source.body.modules;
  if (
    failure.moduleKeys !== undefined &&
    failure.moduleKeys.length > 0 &&
    (failure.reasonCode === "vortex.definition.module_dependency_acyclic" ||
      failure.reasonCode === "vortex.definition.module_dependency_resolved")
  ) {
    const names = failure.moduleKeys.map(
      (key) =>
        modules.find((module) => module.key === key)?.name ??
        key.split(".").at(-1)!.replaceAll("_", " "),
    );
    const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
    return {
      message:
        failure.reasonCode === "vortex.definition.module_dependency_acyclic"
          ? `${list.format(names)} use each other's records in a loop. Change a record type used by an input or a link in one of these modules, or remove the reference.`
          : `${names[0]} uses records from ${list.format(names.slice(1))}, which this application neither owns nor uses. Add the module to the application, or change or remove the reference.`,
      selection: null,
    };
  }
  if (failure.queryKey !== undefined) {
    const module =
      modules.find(
        (item) =>
          item.key === failure.moduleKey &&
          item.queries.some((query) => query.key === failure.queryKey),
      ) ?? modules.find((item) => item.queries.some((query) => query.key === failure.queryKey));
    const query = module?.queries.find((item) => item.key === failure.queryKey);
    if (module !== undefined && query !== undefined)
      return {
        message: `The query ${query.label ?? query.key} can't be used as it is set up. Check its filter, columns, sorting and totals, or remove what does not fit.`,
        selection: { kind: "query", moduleKey: module.key, queryKey: query.key },
      };
  }
  if (failure.recordTypeKey !== undefined) {
    const holds = (item: (typeof modules)[number]) =>
      item.record_types.some(
        (record) =>
          record.key === failure.recordTypeKey &&
          (failure.fieldKey === undefined ||
            record.fields.some((field) => field.key === failure.fieldKey)),
      );
    const module =
      modules.find((item) => item.key === failure.moduleKey && holds(item)) ?? modules.find(holds);
    const record = module?.record_types.find((item) => item.key === failure.recordTypeKey);
    const field =
      failure.fieldKey === undefined
        ? undefined
        : record?.fields.find((item) => item.key === failure.fieldKey);
    if (module !== undefined && record !== undefined && field !== undefined)
      return {
        message: `The field ${field.label} of ${record.plural_name} can't be used as it is set up. ${fieldAdvice[field.type] ?? "Check its settings."} You can also remove it.`,
        selection: {
          kind: "field",
          moduleKey: module.key,
          recordKey: record.key,
          fieldKey: field.key,
        },
      };
    if (module !== undefined && record !== undefined)
      return {
        message: `The record type ${record.plural_name} can't be used as it is set up (${ruleWords(failure.reasonCode)}).`,
        selection: { kind: "record_type", moduleKey: module.key, recordKey: record.key },
      };
  }
  if (failure.blockAlias !== undefined)
    return {
      message: `A block on a page can't be used as it is set up (${ruleWords(failure.reasonCode)}, block ${failure.blockAlias}). Change it on the canvas.`,
      selection: null,
    };
  return {
    message: `Something in the draft can't be used as it is set up (${ruleWords(failure.reasonCode)}).`,
    selection: null,
  };
};
